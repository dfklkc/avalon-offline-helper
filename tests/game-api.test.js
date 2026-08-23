'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('module')

let currentOpenid = ''
let rooms = new Map()
let roomSecrets = new Map()

function clone(value) {
  return value == null ? value : structuredClone(value)
}

function resetDatabase() {
  rooms = new Map()
  roomSecrets = new Map()
}

function mockCollection(name, roomStore, secretStore) {
  const store = name === 'rooms' ? roomStore : secretStore
  return {
    doc(id) {
      return {
        async get() {
          return { data: store.has(id) ? clone(store.get(id)) : null }
        },
        async set(options) {
          assert.equal(
            options && typeof options.data,
            'object',
            'wx-server-sdk 的事务 doc.set 必须传入 { data }'
          )
          store.set(id, { _id: id, ...clone(options.data) })
        },
        async remove() {
          store.delete(id)
        }
      }
    }
  }
}

const database = {
  async runTransaction(callback) {
    const roomCopy = new Map([...rooms].map(([key, value]) => [key, clone(value)]))
    const secretCopy = new Map([...roomSecrets].map(([key, value]) => [key, clone(value)]))
    const transaction = {
      collection(name) {
        return mockCollection(name, roomCopy, secretCopy)
      }
    }
    const result = await callback(transaction)
    rooms = roomCopy
    roomSecrets = secretCopy
    return result
  }
}

const cloudMock = {
  DYNAMIC_CURRENT_ENV: 'mock-env',
  init() {},
  database() {
    return database
  },
  getWXContext() {
    return { OPENID: currentOpenid }
  }
}

const originalModuleLoad = Module._load
Module._load = function loadWithCloudMock(request, parent, isMain) {
  if (request === 'wx-server-sdk') return cloudMock
  return originalModuleLoad.call(this, request, parent, isMain)
}
const gameApi = require('../cloudfunctions/gameApi/index')
Module._load = originalModuleLoad

async function rawCall(openid, action, payload = {}) {
  currentOpenid = openid
  return gameApi.main({ action, ...payload })
}

async function call(openid, action, payload = {}) {
  const response = await rawCall(openid, action, payload)
  assert.equal(response.ok, true, `${action}: ${JSON.stringify(response)}`)
  return response.data
}

async function expectError(openid, action, code, payload = {}) {
  const originalWarn = console.warn
  console.warn = () => {}
  try {
    const response = await rawCall(openid, action, payload)
    assert.equal(response.ok, false)
    assert.equal(response.error.code, code)
  } finally {
    console.warn = originalWarn
  }
}

async function createStartedRoom(prefix) {
  let state = await call(`${prefix}-1`, 'createRoom', {
    nickname: `${prefix}1`,
    desiredPlayers: 5,
    mode: 'classic'
  })
  const roomCode = state.room.code

  for (let seat = 2; seat <= 5; seat += 1) {
    await call(`${prefix}-${seat}`, 'joinRoom', {
      roomCode,
      nickname: `${prefix}${seat}`
    })
  }
  for (let seat = 1; seat <= 5; seat += 1) {
    await call(`${prefix}-${seat}`, 'setReady', { roomCode, ready: true })
  }
  await call(`${prefix}-1`, 'startGame', { roomCode })
  for (let seat = 1; seat <= 5; seat += 1) {
    state = await call(`${prefix}-${seat}`, 'acknowledgeRole', { roomCode })
  }

  const usersByPlayerId = Object.fromEntries(
    state.room.players.map((player, index) => [player.id, `${prefix}-${index + 1}`])
  )
  return { roomCode, state, usersByPlayerId }
}

function nextLeaderId(state) {
  const players = [...state.room.players].sort((left, right) => left.seat - right.seat)
  const currentIndex = players.findIndex((player) => player.id === state.room.leaderPlayerId)
  return players[(currentIndex + 1) % players.length].id
}

async function passQuest(context, checkGoodCannotFail = false) {
  const { roomCode, usersByPlayerId } = context
  let state = await call(Object.values(usersByPlayerId)[0], 'getState', { roomCode })
  const proposingLeaderId = state.room.leaderPlayerId
  const expectedNextLeaderId = nextLeaderId(state)
  const secret = roomSecrets.get(roomCode)
  const goodPlayerId = Object.keys(secret.rolesByPlayer).find((playerId) => (
    ['merlin', 'percival', 'loyal'].includes(secret.rolesByPlayer[playerId])
  ))
  const teamPlayerIds = [
    goodPlayerId,
    ...state.room.players.map((player) => player.id).filter((playerId) => playerId !== goodPlayerId)
  ].slice(0, state.room.teamSize)

  await call(usersByPlayerId[proposingLeaderId], 'proposeTeam', {
    roomCode,
    teamPlayerIds
  })
  for (const [index, user] of Object.values(usersByPlayerId).entries()) {
    state = await call(user, 'castTeamVote', { roomCode, approved: true })
    if (index === 0) {
      assert.deepEqual(state.room.teamVoteProgress, { submitted: 1, total: 5 })
      assert.equal(state.room.proposalHistory.length, state.room.questHistory.length)
    }
  }

  assert.equal(
    state.room.leaderPlayerId,
    proposingLeaderId,
    '获批后执行任务期间仍应显示本轮领队'
  )
  const proposal = state.room.proposalHistory.at(-1)
  assert.equal(proposal.votes.length, 5)
  assert.deepEqual(new Set(proposal.votes.map((vote) => vote.vote)), new Set(['approve']))

  if (checkGoodCannotFail) {
    await expectError(usersByPlayerId[goodPlayerId], 'castMissionVote', 'GOOD_CANNOT_FAIL', {
      roomCode,
      vote: 'fail'
    })
  }

  for (const [index, playerId] of teamPlayerIds.entries()) {
    state = await call(usersByPlayerId[playerId], 'castMissionVote', {
      roomCode,
      vote: 'success'
    })
    if (index === 0 && teamPlayerIds.length > 1) {
      assert.deepEqual(state.room.missionVoteProgress, {
        submitted: 1,
        total: teamPlayerIds.length
      })
    }
  }

  assert.equal(state.room.leaderPlayerId, expectedNextLeaderId, '任务结算后应将领队顺时针移动一次')
  const quest = state.room.questHistory.at(-1)
  assert.equal(quest.successVotes, teamPlayerIds.length)
  assert.equal(quest.failVotes, 0)
  assert.equal(Object.prototype.hasOwnProperty.call(quest, 'votes'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(quest, 'votesByPlayer'), false)
  return state
}

test('gameApi 云函数状态机', async (t) => {
  await t.test('完整成功局、私密数据隔离与重赛清理', async () => {
    resetDatabase()
    const context = await createStartedRoom('a')
    const { roomCode, usersByPlayerId } = context
    let state = await call('a-1', 'getState', { roomCode })
    const targetPlayerId = state.room.players[1].id

    await call('a-1', 'savePlayerNote', {
      roomCode,
      targetPlayerId,
      mark: 'suspect',
      note: 'private-note-731'
    })
    state = await call('a-1', 'getState', { roomCode })
    assert.equal(state.privateView.playerNotes[targetPlayerId].note, 'private-note-731')
    state = await call('a-2', 'getState', { roomCode })
    assert.equal(JSON.stringify(state).includes('private-note-731'), false)

    const reconnected = await call('a-2', 'joinRoom', { roomCode, nickname: 'changed' })
    assert.equal(
      reconnected.room.players.find((player) => player.id === reconnected.me.id).nickname,
      'a2',
      '游戏中重连不应改名或新增座位'
    )

    state = await passQuest(context, true)
    state = await passQuest(context)
    state = await passQuest(context)
    assert.equal(state.room.status, 'assassination')
    assert.equal(state.room.questIndex, 2)

    const secret = roomSecrets.get(roomCode)
    const assassinId = Object.keys(secret.rolesByPlayer).find((id) => secret.rolesByPlayer[id] === 'assassin')
    const merlinId = Object.keys(secret.rolesByPlayer).find((id) => secret.rolesByPlayer[id] === 'merlin')
    state = await call(usersByPlayerId[assassinId], 'assassinate', {
      roomCode,
      targetPlayerId: merlinId
    })
    assert.equal(state.room.winner, 'evil')
    assert.equal(state.room.finishReason, 'merlin_assassinated')
    assert.equal(state.room.players.some((player) => Object.hasOwn(player, 'openid')), false)
    await expectError('a-2', 'leaveRoom', 'INVALID_PHASE', { roomCode })
    assert.equal((await call('a-1', 'getState', { roomCode })).room.revealedRoles.length, 5)

    state = await call('a-1', 'rematch', { roomCode })
    assert.equal(state.room.status, 'lobby')
    assert.deepEqual(state.privateView.playerNotes, {})
    assert.equal(Object.keys(roomSecrets.get(roomCode).notesByPlayer).length, 5)
  })

  await t.test('第五次组队否决立即判邪恶胜利', async () => {
    resetDatabase()
    const context = await createStartedRoom('b')
    let state = context.state

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      state = await call('b-1', 'getState', { roomCode: context.roomCode })
      const leaderId = state.room.leaderPlayerId
      const expectedNextLeaderId = nextLeaderId(state)
      const teamPlayerIds = state.room.players
        .slice(0, state.room.teamSize)
        .map((player) => player.id)
      await call(context.usersByPlayerId[leaderId], 'proposeTeam', {
        roomCode: context.roomCode,
        teamPlayerIds
      })
      for (const user of Object.values(context.usersByPlayerId)) {
        state = await call(user, 'castTeamVote', {
          roomCode: context.roomCode,
          approved: false
        })
      }
      assert.equal(state.room.leaderPlayerId, expectedNextLeaderId)
    }

    assert.equal(state.room.status, 'finished')
    assert.equal(state.room.winner, 'evil')
    assert.equal(state.room.finishReason, 'five_rejected_proposals')
    assert.equal(state.room.proposalHistory.length, 5)
    assert.equal(state.room.questHistory.length, 0)
  })

  await t.test('房主权限、踢人和最后一人退出删房', async () => {
    resetDatabase()
    let state = await call('c-1', 'createRoom', {
      nickname: 'c1',
      desiredPlayers: 5,
      mode: 'beginner'
    })
    const roomCode = state.room.code
    state = await call('c-1', 'updateSettings', {
      roomCode,
      desiredPlayers: 6,
      mode: 'classic'
    })
    assert.equal(state.room.desiredPlayers, 6)
    assert.equal(state.room.roleDeck.length, 6)

    state = await call('c-2', 'joinRoom', { roomCode, nickname: 'c2' })
    const guestId = state.me.id
    await expectError('c-2', 'kickPlayer', 'HOST_ONLY', {
      roomCode,
      targetPlayerId: state.room.players[0].id
    })
    state = await call('c-1', 'kickPlayer', { roomCode, targetPlayerId: guestId })
    assert.equal(state.room.players.length, 1)

    const result = await call('c-1', 'leaveRoom', { roomCode })
    assert.deepEqual(result, { left: true, roomCode, roomDeleted: true })
    assert.equal(rooms.has(roomCode), false)
    assert.equal(roomSecrets.has(roomCode), false)
  })

  await t.test('拒绝对象原型上的伪 action', async () => {
    resetDatabase()
    await expectError('d-1', 'constructor', 'UNKNOWN_ACTION')
    await expectError('d-1', '__proto__', 'UNKNOWN_ACTION')
  })
})
