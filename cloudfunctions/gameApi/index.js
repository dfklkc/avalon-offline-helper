'use strict'

const cloud = require('wx-server-sdk')
const crypto = require('crypto')

const {
  buildRoleDeck,
  getKnowledge,
  getRules,
  isMissionSuccessful,
  isTeamApproved,
  normalizeNickname: normalizeNicknameDomain,
  normalizeRoomCode: normalizeRoomCodeDomain,
  publicRole,
  secureShuffle
} = require('./domain')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const ROOMS = 'rooms'
const ROOM_SECRETS = 'room_secrets'
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const ROOM_CODE_ATTEMPTS = 10
const MODES = new Set(['beginner', 'classic'])
const NOTE_MARKS = new Set(['unknown', 'trusted', 'watch', 'suspect'])
class ApiError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ApiError'
    this.code = code
  }
}

function assert(condition, code, message) {
  if (!condition) throw new ApiError(code, message)
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key)
}

function now() {
  return new Date().toISOString()
}

function generateRoomCode() {
  let code = ''
  for (let index = 0; index < 6; index += 1) {
    code += ROOM_CODE_ALPHABET[crypto.randomInt(ROOM_CODE_ALPHABET.length)]
  }
  return code
}

function generatePlayerId() {
  return `p_${crypto.randomBytes(8).toString('hex')}`
}

function normalizeMode(value) {
  const mode = String(value || '').trim().toLowerCase()
  assert(MODES.has(mode), 'INVALID_MODE', '模式必须是 beginner 或 classic')
  return mode
}

function normalizeNickname(value) {
  try {
    return normalizeNicknameDomain(value)
  } catch (error) {
    throw new ApiError('INVALID_NICKNAME', error.message || '昵称不合法')
  }
}

function normalizeRoomCode(value) {
  try {
    return normalizeRoomCodeDomain(value)
  } catch (error) {
    throw new ApiError('INVALID_ROOM_CODE', error.message || '房间码不合法')
  }
}

function normalizeDesiredPlayers(value) {
  const count = Number(value)
  assert(Number.isInteger(count) && count >= 5 && count <= 10, 'INVALID_PLAYER_COUNT', '游戏仅支持 5 至 10 人')
  return count
}

function normalizeReady(value) {
  assert(typeof value === 'boolean', 'INVALID_READY', 'ready 必须是布尔值')
  return value
}

function normalizeNoteMark(value) {
  const mark = String(value || 'unknown').trim().toLowerCase()
  assert(NOTE_MARKS.has(mark), 'INVALID_NOTE_MARK', '标记必须是 unknown、trusted、watch 或 suspect')
  return mark
}

function normalizeNote(value) {
  const note = String(value || '').trim()
  assert([...note].length <= 80, 'NOTE_TOO_LONG', '备注最多 80 个字符')
  return note
}

function sortedPlayers(room) {
  return [...(room.players || [])].sort((left, right) => left.seat - right.seat)
}

function publicPlayer(player) {
  return {
    id: player.id,
    nickname: player.nickname,
    seat: player.seat,
    ready: Boolean(player.ready)
  }
}

function findPlayerByOpenid(room, openid) {
  return (room.players || []).find((player) => player.openid === openid) || null
}

function findPlayerById(room, playerId) {
  return (room.players || []).find((player) => player.id === playerId) || null
}

function requireMember(room, openid) {
  const player = findPlayerByOpenid(room, openid)
  assert(player, 'NOT_IN_ROOM', '你不在该房间中')
  return player
}

function requireHost(room, player) {
  assert(room.hostPlayerId === player.id, 'HOST_ONLY', '仅房主可执行此操作')
}

function requireStatus(room, ...statuses) {
  assert(
    statuses.includes(room.status),
    'INVALID_PHASE',
    `当前阶段 ${room.status} 不允许执行此操作`
  )
}

function roleDeckFor(playerCount, mode) {
  return buildRoleDeck(playerCount, mode).map((roleKey) => publicRole(roleKey))
}

function documentData(value) {
  const data = { ...value }
  delete data._id
  return data
}

function isDocumentMissing(error) {
  const text = [error && error.code, error && error.errCode, error && error.message]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return (
    text.includes('not exist') ||
    text.includes('not found') ||
    text.includes('does not exist') ||
    text.includes('document_nonexist')
  )
}

async function getOptionalDocument(transaction, collectionName, documentId) {
  try {
    const response = await transaction.collection(collectionName).doc(documentId).get()
    const data = response && response.data
    if (!data || (Array.isArray(data) && data.length === 0)) return null
    return Array.isArray(data) ? data[0] : data
  } catch (error) {
    if (isDocumentMissing(error)) return null
    throw error
  }
}

async function setDocument(transaction, collectionName, documentId, value) {
  // wx-server-sdk keeps the Mini Program-style `{ data }` envelope even
  // though its wrapped transaction delegates to the lower-level Node SDK.
  await transaction.collection(collectionName).doc(documentId).set({
    data: documentData(value)
  })
}

async function persistRoom(transaction, room) {
  room.updatedAt = now()
  room.version = Number(room.version || 0) + 1
  await setDocument(transaction, ROOMS, room.code, room)
}

async function persistSecrets(transaction, roomCode, secrets) {
  secrets.updatedAt = now()
  secrets.version = Number(secrets.version || 0) + 1
  await setDocument(transaction, ROOM_SECRETS, roomCode, secrets)
}

async function loadRoom(transaction, roomCode) {
  const room = await getOptionalDocument(transaction, ROOMS, roomCode)
  assert(room, 'ROOM_NOT_FOUND', '房间不存在或已过期')
  const secrets = await getOptionalDocument(transaction, ROOM_SECRETS, roomCode)
  assert(secrets, 'ROOM_DATA_INCOMPLETE', '房间数据不完整，请重新建房')
  return { room, secrets }
}

function publicProposalHistory(history) {
  return (history || []).map((proposal) => ({
    questIndex: proposal.questIndex,
    proposalAttempt: proposal.proposalAttempt,
    leaderPlayerId: proposal.leaderPlayerId,
    teamPlayerIds: [...proposal.teamPlayerIds],
    votes: (proposal.votes || []).map((vote) => ({
      playerId: vote.playerId,
      vote: vote.vote
    })),
    approveCount: proposal.approveCount,
    rejectCount: proposal.rejectCount,
    approved: Boolean(proposal.approved)
  }))
}

function publicQuestHistory(history) {
  return (history || []).map((quest) => ({
    questIndex: quest.questIndex,
    proposalAttempt: quest.proposalAttempt,
    leaderPlayerId: quest.leaderPlayerId,
    teamPlayerIds: [...quest.teamPlayerIds],
    failThreshold: quest.failThreshold,
    successVotes: quest.successVotes,
    failVotes: quest.failVotes,
    succeeded: Boolean(quest.succeeded),
    result: quest.result
  }))
}

function ownPlayerNotes(room, secrets, playerId) {
  const source = (secrets.notesByPlayer && secrets.notesByPlayer[playerId]) || {}
  const result = {}
  for (const target of room.players || []) {
    if (target.id === playerId || !source[target.id]) continue
    result[target.id] = {
      mark: source[target.id].mark,
      note: source[target.id].note
    }
  }
  return result
}

function buildState(room, secrets, openid) {
  const member = requireMember(room, openid)
  const players = sortedPlayers(room)
  const publicPlayers = players.map(publicPlayer)
  const publicPlayersById = Object.fromEntries(publicPlayers.map((player) => [player.id, player]))
  const rolesByPlayer = secrets.rolesByPlayer || {}
  const roleKey = rolesByPlayer[member.id] || null
  const savedKnowledge = roleKey && secrets.knowledgeByPlayer
    ? secrets.knowledgeByPlayer[member.id]
    : null
  const knowledge = roleKey ? (savedKnowledge || getKnowledge(member.id, rolesByPlayer)) : null
  const currentProposal = room.currentProposal
  const teamPlayerIds = currentProposal ? currentProposal.teamPlayerIds : []
  const teamVotes = secrets.teamVotesByPlayer || {}
  const missionVotes = secrets.missionVotesByPlayer || {}
  const acknowledged = secrets.roleAcknowledgedByPlayer || {}

  const roomView = {
    code: room.code,
    status: room.status,
    desiredPlayers: room.desiredPlayers,
    mode: room.mode,
    hostPlayerId: room.hostPlayerId,
    players: publicPlayers,
    roleDeck: (room.roleDeck || []).map((role) => ({ ...role })),
    leaderPlayerId: room.leaderPlayerId || null,
    leaderIndex: Number.isInteger(room.leaderIndex) ? room.leaderIndex : null,
    questIndex: Number.isInteger(room.questIndex) ? room.questIndex : null,
    proposalAttempt: Number(room.proposalAttempt || 0),
    teamSize: Number(room.teamSize || 0),
    failThreshold: Number(room.failThreshold || 0),
    goodWins: Number(room.goodWins || 0),
    evilWins: Number(room.evilWins || 0),
    currentProposal: currentProposal
      ? { teamPlayerIds: [...currentProposal.teamPlayerIds] }
      : null,
    teamVoteProgress: {
      submitted: room.status === 'team_vote'
        ? room.players.filter((player) => own(teamVotes, player.id)).length
        : 0,
      total: room.status === 'team_vote' ? room.players.length : 0
    },
    missionVoteProgress: {
      submitted: room.status === 'mission_vote'
        ? teamPlayerIds.filter((playerId) => own(missionVotes, playerId)).length
        : 0,
      total: room.status === 'mission_vote' ? teamPlayerIds.length : 0
    },
    questHistory: publicQuestHistory(room.questHistory),
    proposalHistory: publicProposalHistory(room.proposalHistory),
    winner: room.winner || null,
    finishReason: room.finishReason || null,
    version: Number(room.version || 0)
  }

  if (room.assassination) {
    roomView.assassination = {
      assassinPlayerId: room.assassination.assassinPlayerId,
      targetPlayerId: room.assassination.targetPlayerId,
      hitMerlin: Boolean(room.assassination.hitMerlin)
    }
  }

  if (room.status === 'finished') {
    roomView.revealedRoles = players
      .filter((player) => rolesByPlayer[player.id])
      .map((player) => ({
        playerId: player.id,
        role: publicRole(rolesByPlayer[player.id])
      }))
  }

  return {
    room: roomView,
    me: {
      id: member.id,
      isHost: room.hostPlayerId === member.id,
      ready: Boolean(member.ready),
      roleAcknowledged: Boolean(acknowledged[member.id]),
      hasTeamVoted: own(teamVotes, member.id),
      hasMissionVoted: own(missionVotes, member.id),
      isOnMission: teamPlayerIds.includes(member.id)
    },
    privateView: {
      role: roleKey ? publicRole(roleKey) : null,
      knowledge: knowledge
        ? {
            title: knowledge.title,
            description: knowledge.description,
            players: (knowledge.playerIds || [])
              .map((playerId) => publicPlayersById[playerId])
              .filter(Boolean)
          }
        : null,
      playerNotes: ownPlayerNotes(room, secrets, member.id)
    }
  }
}

function createInitialRoom(roomCode, hostPlayer, desiredPlayers, mode) {
  const timestamp = now()
  return {
    code: roomCode,
    status: 'lobby',
    desiredPlayers,
    mode,
    hostPlayerId: hostPlayer.id,
    players: [hostPlayer],
    roleDeck: roleDeckFor(desiredPlayers, mode),
    leaderPlayerId: null,
    leaderIndex: null,
    questIndex: null,
    proposalAttempt: 0,
    teamSize: 0,
    failThreshold: 0,
    goodWins: 0,
    evilWins: 0,
    currentProposal: null,
    questHistory: [],
    proposalHistory: [],
    winner: null,
    finishReason: null,
    assassination: null,
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp
  }
}

function createInitialSecrets(roomCode, hostPlayerId) {
  const timestamp = now()
  return {
    roomCode,
    rolesByPlayer: {},
    knowledgeByPlayer: {},
    roleAcknowledgedByPlayer: {},
    teamVotesByPlayer: {},
    missionVotesByPlayer: {},
    notesByPlayer: { [hostPlayerId]: {} },
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp
  }
}

async function createRoom(event, openid) {
  const nickname = normalizeNickname(event.nickname)
  const desiredPlayers = normalizeDesiredPlayers(event.desiredPlayers)
  const mode = normalizeMode(event.mode)

  for (let attempt = 0; attempt < ROOM_CODE_ATTEMPTS; attempt += 1) {
    const roomCode = generateRoomCode()
    const player = {
      id: generatePlayerId(),
      openid,
      nickname,
      seat: 0,
      ready: false,
      joinedAt: now()
    }
    const room = createInitialRoom(roomCode, player, desiredPlayers, mode)
    const secrets = createInitialSecrets(roomCode, player.id)

    try {
      return await db.runTransaction(async (transaction) => {
        const existing = await getOptionalDocument(transaction, ROOMS, roomCode)
        if (existing) throw new ApiError('ROOM_CODE_COLLISION', '房间码冲突')
        await setDocument(transaction, ROOMS, roomCode, room)
        await setDocument(transaction, ROOM_SECRETS, roomCode, secrets)
        return buildState(room, secrets, openid)
      })
    } catch (error) {
      if (error instanceof ApiError && error.code === 'ROOM_CODE_COLLISION') continue
      throw error
    }
  }

  throw new ApiError('ROOM_CODE_UNAVAILABLE', '暂时无法生成房间码，请重试')
}

async function joinRoom(event, openid) {
  const roomCode = normalizeRoomCode(event.roomCode)
  const nickname = normalizeNickname(event.nickname)

  return db.runTransaction(async (transaction) => {
    const { room, secrets } = await loadRoom(transaction, roomCode)
    const existing = findPlayerByOpenid(room, openid)
    if (existing) {
      // Rejoining is allowed in every phase. During a live game the stored
      // identity remains stable; nickname changes are only accepted in lobby.
      if (room.status === 'lobby') {
        const duplicate = room.players.some((player) => (
          player.id !== existing.id && player.nickname === nickname
        ))
        assert(!duplicate, 'NICKNAME_TAKEN', '房间内已有同名玩家')
        if (existing.nickname !== nickname) {
          existing.nickname = nickname
          await persistRoom(transaction, room)
        }
      }
      return buildState(room, secrets, openid)
    }

    requireStatus(room, 'lobby')
    assert(room.players.length < room.desiredPlayers, 'ROOM_FULL', '房间已满')
    assert(
      !room.players.some((player) => player.nickname === nickname),
      'NICKNAME_TAKEN',
      '房间内已有同名玩家'
    )

    const player = {
      id: generatePlayerId(),
      openid,
      nickname,
      seat: room.players.length,
      ready: false,
      joinedAt: now()
    }
    room.players.push(player)
    secrets.notesByPlayer = secrets.notesByPlayer || {}
    secrets.notesByPlayer[player.id] = {}
    await persistRoom(transaction, room)
    await persistSecrets(transaction, roomCode, secrets)
    return buildState(room, secrets, openid)
  })
}

async function getState(event, openid) {
  const roomCode = normalizeRoomCode(event.roomCode)
  return db.runTransaction(async (transaction) => {
    const { room, secrets } = await loadRoom(transaction, roomCode)
    requireMember(room, openid)
    return buildState(room, secrets, openid)
  })
}

async function setReady(event, openid) {
  const roomCode = normalizeRoomCode(event.roomCode)
  const ready = normalizeReady(event.ready)
  return db.runTransaction(async (transaction) => {
    const { room, secrets } = await loadRoom(transaction, roomCode)
    requireStatus(room, 'lobby')
    const player = requireMember(room, openid)
    if (player.ready !== ready) {
      player.ready = ready
      await persistRoom(transaction, room)
    }
    return buildState(room, secrets, openid)
  })
}

async function updateSettings(event, openid) {
  const roomCode = normalizeRoomCode(event.roomCode)
  return db.runTransaction(async (transaction) => {
    const { room, secrets } = await loadRoom(transaction, roomCode)
    requireStatus(room, 'lobby')
    const player = requireMember(room, openid)
    requireHost(room, player)

    const desiredPlayers = own(event, 'desiredPlayers')
      ? normalizeDesiredPlayers(event.desiredPlayers)
      : room.desiredPlayers
    const mode = own(event, 'mode') ? normalizeMode(event.mode) : room.mode
    assert(desiredPlayers >= room.players.length, 'TOO_MANY_PLAYERS', '新人数上限不能小于当前房间人数')

    const changed = desiredPlayers !== room.desiredPlayers || mode !== room.mode
    if (changed) {
      room.desiredPlayers = desiredPlayers
      room.mode = mode
      room.roleDeck = roleDeckFor(desiredPlayers, mode)
      room.players.forEach((member) => {
        member.ready = false
      })
      await persistRoom(transaction, room)
    }
    return buildState(room, secrets, openid)
  })
}

async function startGame(event, openid) {
  const roomCode = normalizeRoomCode(event.roomCode)
  return db.runTransaction(async (transaction) => {
    const { room, secrets } = await loadRoom(transaction, roomCode)
    requireStatus(room, 'lobby')
    const player = requireMember(room, openid)
    requireHost(room, player)
    assert(room.players.length === room.desiredPlayers, 'PLAYER_COUNT_MISMATCH', '房间人数尚未达到设定人数')
    assert(room.players.every((member) => member.ready), 'PLAYERS_NOT_READY', '请等待所有玩家准备')

    const players = sortedPlayers(room)
    const rules = getRules(players.length)
    const shuffledRoles = secureShuffle(buildRoleDeck(players.length, room.mode))
    const rolesByPlayer = {}
    players.forEach((member, index) => {
      rolesByPlayer[member.id] = shuffledRoles[index]
    })
    const knowledgeByPlayer = {}
    players.forEach((member) => {
      knowledgeByPlayer[member.id] = getKnowledge(member.id, rolesByPlayer)
    })
    const leaderIndex = crypto.randomInt(players.length)

    room.status = 'role_reveal'
    room.roleDeck = roleDeckFor(players.length, room.mode)
    room.leaderIndex = leaderIndex
    room.leaderPlayerId = players[leaderIndex].id
    room.questIndex = 0
    room.proposalAttempt = 1
    room.teamSize = rules.teamSizes[0]
    room.failThreshold = rules.failThresholds[0]
    room.goodWins = 0
    room.evilWins = 0
    room.currentProposal = null
    room.questHistory = []
    room.proposalHistory = []
    room.winner = null
    room.finishReason = null
    room.assassination = null

    secrets.rolesByPlayer = rolesByPlayer
    secrets.knowledgeByPlayer = knowledgeByPlayer
    secrets.roleAcknowledgedByPlayer = Object.fromEntries(players.map((member) => [member.id, false]))
    secrets.teamVotesByPlayer = {}
    secrets.missionVotesByPlayer = {}
    secrets.notesByPlayer = secrets.notesByPlayer || {}

    await persistRoom(transaction, room)
    await persistSecrets(transaction, roomCode, secrets)
    return buildState(room, secrets, openid)
  })
}

async function acknowledgeRole(event, openid) {
  const roomCode = normalizeRoomCode(event.roomCode)
  return db.runTransaction(async (transaction) => {
    const { room, secrets } = await loadRoom(transaction, roomCode)
    const player = requireMember(room, openid)
    const acknowledgements = secrets.roleAcknowledgedByPlayer || {}

    // A lost response from the final acknowledgement may be retried after the
    // room has already advanced. Treat that exact replay as successful.
    if (acknowledgements[player.id] && room.status !== 'lobby') {
      return buildState(room, secrets, openid)
    }
    requireStatus(room, 'role_reveal')

    if (!acknowledgements[player.id]) {
      acknowledgements[player.id] = true
      secrets.roleAcknowledgedByPlayer = acknowledgements
      if (room.players.every((member) => acknowledgements[member.id])) {
        room.status = 'team_building'
        await persistRoom(transaction, room)
      }
      await persistSecrets(transaction, roomCode, secrets)
    }
    return buildState(room, secrets, openid)
  })
}

function validateTeam(room, teamPlayerIds) {
  assert(Array.isArray(teamPlayerIds), 'INVALID_TEAM', 'teamPlayerIds 必须是数组')
  assert(teamPlayerIds.length === room.teamSize, 'INVALID_TEAM_SIZE', `本轮需要 ${room.teamSize} 名队员`)
  assert(new Set(teamPlayerIds).size === teamPlayerIds.length, 'DUPLICATE_TEAM_MEMBER', '任务队员不能重复')
  assert(
    teamPlayerIds.every((playerId) => typeof playerId === 'string' && findPlayerById(room, playerId)),
    'UNKNOWN_TEAM_MEMBER',
    '任务队中包含非本房间玩家'
  )
}

async function proposeTeam(event, openid) {
  const roomCode = normalizeRoomCode(event.roomCode)
  return db.runTransaction(async (transaction) => {
    const { room, secrets } = await loadRoom(transaction, roomCode)
    requireStatus(room, 'team_building')
    const player = requireMember(room, openid)
    assert(player.id === room.leaderPlayerId, 'LEADER_ONLY', '仅当前领队可以组队')
    validateTeam(room, event.teamPlayerIds)

    room.currentProposal = {
      teamPlayerIds: [...event.teamPlayerIds],
      leaderPlayerId: player.id,
      questIndex: room.questIndex,
      proposalAttempt: room.proposalAttempt
    }
    room.status = 'team_vote'
    secrets.teamVotesByPlayer = {}
    secrets.missionVotesByPlayer = {}
    await persistRoom(transaction, room)
    await persistSecrets(transaction, roomCode, secrets)
    return buildState(room, secrets, openid)
  })
}

function advanceLeader(room, proposingLeaderId) {
  const players = sortedPlayers(room)
  const currentIndex = players.findIndex((player) => player.id === proposingLeaderId)
  assert(currentIndex >= 0, 'INVALID_LEADER', '当前领队不存在')
  room.leaderIndex = (currentIndex + 1) % players.length
  room.leaderPlayerId = players[room.leaderIndex].id
}

async function castTeamVote(event, openid) {
  const roomCode = normalizeRoomCode(event.roomCode)
  assert(typeof event.approved === 'boolean', 'INVALID_TEAM_VOTE', 'approved 必须是布尔值')

  return db.runTransaction(async (transaction) => {
    const { room, secrets } = await loadRoom(transaction, roomCode)
    requireStatus(room, 'team_vote')
    const player = requireMember(room, openid)
    assert(room.currentProposal, 'MISSING_PROPOSAL', '当前没有可表决的队伍')
    const votes = secrets.teamVotesByPlayer || {}

    if (own(votes, player.id)) {
      assert(votes[player.id] === event.approved, 'ALREADY_VOTED', '你已提交组队票，不能修改')
      return buildState(room, secrets, openid)
    }

    votes[player.id] = event.approved
    secrets.teamVotesByPlayer = votes
    const allVoted = room.players.every((member) => own(votes, member.id))
    if (!allVoted) {
      await persistSecrets(transaction, roomCode, secrets)
      return buildState(room, secrets, openid)
    }

    const orderedPlayers = sortedPlayers(room)
    const approved = isTeamApproved(votes)
    const approveCount = orderedPlayers.filter((member) => votes[member.id]).length
    const proposal = room.currentProposal
    room.proposalHistory.push({
      questIndex: proposal.questIndex,
      proposalAttempt: proposal.proposalAttempt,
      leaderPlayerId: proposal.leaderPlayerId,
      teamPlayerIds: [...proposal.teamPlayerIds],
      votes: orderedPlayers.map((member) => ({
        playerId: member.id,
        vote: votes[member.id] ? 'approve' : 'reject'
      })),
      approveCount,
      rejectCount: orderedPlayers.length - approveCount,
      approved
    })

    if (approved) {
      room.status = 'mission_vote'
      secrets.missionVotesByPlayer = {}
    } else {
      // A rejected proposal passes leadership immediately. An approved
      // proposal keeps its leader through the mission and passes afterward.
      advanceLeader(room, proposal.leaderPlayerId)
      if (room.proposalAttempt >= 5) {
        room.status = 'finished'
        room.winner = 'evil'
        room.finishReason = 'five_rejected_proposals'
        room.currentProposal = null
        secrets.teamVotesByPlayer = {}
        secrets.missionVotesByPlayer = {}
      } else {
        room.status = 'team_building'
        room.proposalAttempt += 1
        room.currentProposal = null
        secrets.teamVotesByPlayer = {}
        secrets.missionVotesByPlayer = {}
      }
    }

    await persistRoom(transaction, room)
    await persistSecrets(transaction, roomCode, secrets)
    return buildState(room, secrets, openid)
  })
}

async function castMissionVote(event, openid) {
  const roomCode = normalizeRoomCode(event.roomCode)
  const vote = String(event.vote || '').trim().toLowerCase()
  assert(vote === 'success' || vote === 'fail', 'INVALID_MISSION_VOTE', '任务票必须是 success 或 fail')

  return db.runTransaction(async (transaction) => {
    const { room, secrets } = await loadRoom(transaction, roomCode)
    requireStatus(room, 'mission_vote')
    const player = requireMember(room, openid)
    const proposal = room.currentProposal
    assert(proposal, 'MISSING_PROPOSAL', '当前没有执行中的任务')
    assert(proposal.teamPlayerIds.includes(player.id), 'MISSION_TEAM_ONLY', '仅任务队员可投任务票')

    const roleKey = (secrets.rolesByPlayer || {})[player.id]
    const role = roleKey ? publicRole(roleKey) : null
    assert(role, 'ROLE_NOT_FOUND', '未找到你的角色')
    assert(!(role.camp === 'good' && vote === 'fail'), 'GOOD_CANNOT_FAIL', '善良阵营只能提交任务成功')

    const votes = secrets.missionVotesByPlayer || {}
    if (own(votes, player.id)) {
      assert(votes[player.id] === vote, 'ALREADY_VOTED', '你已提交任务票，不能修改')
      return buildState(room, secrets, openid)
    }
    votes[player.id] = vote
    secrets.missionVotesByPlayer = votes

    const allVoted = proposal.teamPlayerIds.every((playerId) => own(votes, playerId))
    if (!allVoted) {
      await persistSecrets(transaction, roomCode, secrets)
      return buildState(room, secrets, openid)
    }

    const missionVotes = Object.fromEntries(
      proposal.teamPlayerIds.map((playerId) => [playerId, votes[playerId]])
    )
    const result = isMissionSuccessful(missionVotes, room.failThreshold)
    const succeeded = result.succeeded
    room.questHistory.push({
      questIndex: room.questIndex,
      proposalAttempt: proposal.proposalAttempt,
      leaderPlayerId: proposal.leaderPlayerId,
      teamPlayerIds: [...proposal.teamPlayerIds],
      failThreshold: room.failThreshold,
      successVotes: proposal.teamPlayerIds.length - result.failVotes,
      failVotes: result.failVotes,
      succeeded,
      result: succeeded ? 'success' : 'fail'
    })

    if (succeeded) room.goodWins += 1
    else room.evilWins += 1

    // Approved teams retain their leader during the mission. Passing the
    // crown here advances it exactly once for the next round.
    advanceLeader(room, proposal.leaderPlayerId)
    room.currentProposal = null
    secrets.teamVotesByPlayer = {}
    secrets.missionVotesByPlayer = {}

    if (room.goodWins >= 3) {
      room.status = 'assassination'
    } else if (room.evilWins >= 3) {
      room.status = 'finished'
      room.winner = 'evil'
      room.finishReason = 'three_failed_quests'
    } else {
      const nextQuestIndex = room.questIndex + 1
      const rules = getRules(room.players.length)
      room.questIndex = nextQuestIndex
      room.proposalAttempt = 1
      room.teamSize = rules.teamSizes[nextQuestIndex]
      room.failThreshold = rules.failThresholds[nextQuestIndex]
      room.status = 'team_building'
    }

    await persistRoom(transaction, room)
    await persistSecrets(transaction, roomCode, secrets)
    return buildState(room, secrets, openid)
  })
}

async function assassinate(event, openid) {
  const roomCode = normalizeRoomCode(event.roomCode)
  const targetPlayerId = String(event.targetPlayerId || '')
  return db.runTransaction(async (transaction) => {
    const { room, secrets } = await loadRoom(transaction, roomCode)
    requireStatus(room, 'assassination')
    const player = requireMember(room, openid)
    assert((secrets.rolesByPlayer || {})[player.id] === 'assassin', 'ASSASSIN_ONLY', '仅刺客可以执行刺杀')
    const target = findPlayerById(room, targetPlayerId)
    assert(target, 'TARGET_NOT_FOUND', '刺杀目标不存在')
    assert(target.id !== player.id, 'INVALID_TARGET', '刺客不能选择自己')

    const hitMerlin = secrets.rolesByPlayer[target.id] === 'merlin'
    room.status = 'finished'
    room.winner = hitMerlin ? 'evil' : 'good'
    room.finishReason = hitMerlin ? 'merlin_assassinated' : 'merlin_survived'
    room.assassination = {
      assassinPlayerId: player.id,
      targetPlayerId: target.id,
      hitMerlin
    }
    await persistRoom(transaction, room)
    return buildState(room, secrets, openid)
  })
}

function resetSecretsForRematch(secrets) {
  secrets.rolesByPlayer = {}
  secrets.knowledgeByPlayer = {}
  secrets.roleAcknowledgedByPlayer = {}
  secrets.teamVotesByPlayer = {}
  secrets.missionVotesByPlayer = {}
  // Notes are intentionally cleared: a new deal must not inherit old alignment reads.
  secrets.notesByPlayer = {}
}

async function rematch(event, openid) {
  const roomCode = normalizeRoomCode(event.roomCode)
  return db.runTransaction(async (transaction) => {
    const { room, secrets } = await loadRoom(transaction, roomCode)
    requireStatus(room, 'finished')
    const player = requireMember(room, openid)
    requireHost(room, player)

    room.status = 'lobby'
    room.players = sortedPlayers(room).map((member, seat) => ({
      ...member,
      seat,
      ready: false
    }))
    room.roleDeck = roleDeckFor(room.desiredPlayers, room.mode)
    room.leaderPlayerId = null
    room.leaderIndex = null
    room.questIndex = null
    room.proposalAttempt = 0
    room.teamSize = 0
    room.failThreshold = 0
    room.goodWins = 0
    room.evilWins = 0
    room.currentProposal = null
    room.questHistory = []
    room.proposalHistory = []
    room.winner = null
    room.finishReason = null
    room.assassination = null
    resetSecretsForRematch(secrets)
    room.players.forEach((member) => {
      secrets.notesByPlayer[member.id] = {}
    })

    await persistRoom(transaction, room)
    await persistSecrets(transaction, roomCode, secrets)
    return buildState(room, secrets, openid)
  })
}

function removePlayerSecrets(secrets, playerId) {
  for (const field of [
    'rolesByPlayer',
    'knowledgeByPlayer',
    'roleAcknowledgedByPlayer',
    'teamVotesByPlayer',
    'missionVotesByPlayer',
    'notesByPlayer'
  ]) {
    if (secrets[field]) delete secrets[field][playerId]
  }
  for (const notes of Object.values(secrets.notesByPlayer || {})) {
    if (notes) delete notes[playerId]
  }
}

function removePlayerFromRoom(room, secrets, playerId) {
  room.players = sortedPlayers(room)
    .filter((player) => player.id !== playerId)
    .map((player, seat) => ({ ...player, seat }))
  removePlayerSecrets(secrets, playerId)
  if (room.hostPlayerId === playerId && room.players.length > 0) {
    room.hostPlayerId = room.players[0].id
  }
}

async function leaveRoom(event, openid) {
  const roomCode = normalizeRoomCode(event.roomCode)
  return db.runTransaction(async (transaction) => {
    const { room, secrets } = await loadRoom(transaction, roomCode)
    requireStatus(room, 'lobby')
    const player = requireMember(room, openid)
    removePlayerFromRoom(room, secrets, player.id)

    if (room.players.length === 0) {
      await transaction.collection(ROOMS).doc(roomCode).remove()
      await transaction.collection(ROOM_SECRETS).doc(roomCode).remove()
      return { left: true, roomCode, roomDeleted: true }
    }

    await persistRoom(transaction, room)
    await persistSecrets(transaction, roomCode, secrets)
    return { left: true, roomCode, roomDeleted: false }
  })
}

async function kickPlayer(event, openid) {
  const roomCode = normalizeRoomCode(event.roomCode)
  const targetPlayerId = String(event.targetPlayerId || '')
  return db.runTransaction(async (transaction) => {
    const { room, secrets } = await loadRoom(transaction, roomCode)
    requireStatus(room, 'lobby')
    const player = requireMember(room, openid)
    requireHost(room, player)
    assert(targetPlayerId !== player.id, 'CANNOT_KICK_SELF', '房主不能踢出自己，请使用退出房间')
    assert(findPlayerById(room, targetPlayerId), 'TARGET_NOT_FOUND', '要踢出的玩家不存在')

    removePlayerFromRoom(room, secrets, targetPlayerId)
    await persistRoom(transaction, room)
    await persistSecrets(transaction, roomCode, secrets)
    return buildState(room, secrets, openid)
  })
}

async function savePlayerNote(event, openid) {
  const roomCode = normalizeRoomCode(event.roomCode)
  const targetPlayerId = String(event.targetPlayerId || '')
  const mark = normalizeNoteMark(event.mark)
  const note = normalizeNote(event.note)
  return db.runTransaction(async (transaction) => {
    const { room, secrets } = await loadRoom(transaction, roomCode)
    const player = requireMember(room, openid)
    const target = findPlayerById(room, targetPlayerId)
    assert(target, 'TARGET_NOT_FOUND', '备注目标不存在')
    assert(target.id !== player.id, 'CANNOT_NOTE_SELF', '不能标记自己')

    secrets.notesByPlayer = secrets.notesByPlayer || {}
    secrets.notesByPlayer[player.id] = secrets.notesByPlayer[player.id] || {}
    if (mark === 'unknown' && !note) {
      delete secrets.notesByPlayer[player.id][target.id]
    } else {
      secrets.notesByPlayer[player.id][target.id] = {
        mark,
        note,
        updatedAt: now()
      }
    }
    await persistSecrets(transaction, roomCode, secrets)
    return buildState(room, secrets, openid)
  })
}

const ACTIONS = Object.freeze({
  createRoom,
  joinRoom,
  getState,
  setReady,
  updateSettings,
  startGame,
  acknowledgeRole,
  proposeTeam,
  castTeamVote,
  castMissionVote,
  assassinate,
  rematch,
  leaveRoom,
  kickPlayer,
  savePlayerNote
})

function publicError(error) {
  if (error instanceof ApiError) {
    return { code: error.code, message: error.message }
  }
  const text = [error && error.code, error && error.errCode, error && error.message]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  if (text.includes('transaction') && (text.includes('conflict') || text.includes('retry'))) {
    return { code: 'CONFLICT', message: '房间状态已更新，请重试' }
  }
  return { code: 'INTERNAL_ERROR', message: '服务暂时不可用，请稍后重试' }
}

exports.main = async (event = {}) => {
  if (!event || typeof event !== 'object' || Array.isArray(event)) event = {}
  const action = String(event.action || '').trim()
  try {
    const handler = ACTIONS[action]
    assert(own(ACTIONS, action) && typeof handler === 'function', 'UNKNOWN_ACTION', '不支持的操作')
    const context = cloud.getWXContext()
    const openid = context && context.OPENID
    assert(openid, 'UNAUTHENTICATED', '无法获取微信身份，请重新进入小程序')
    const data = await handler(event, openid)
    return { ok: true, data }
  } catch (error) {
    if (error instanceof ApiError) {
      console.warn('[gameApi]', action || '<missing>', error.code)
    } else {
      // Never log event payloads or raw database errors: both may contain roles,
      // unopened ballots, or a player's private note.
      console.error(
        '[gameApi]',
        action || '<missing>',
        (error && (error.code || error.errCode || error.name)) || 'UNKNOWN_ERROR'
      )
    }
    return { ok: false, error: publicError(error) }
  }
}
