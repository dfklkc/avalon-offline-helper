'use strict'

const game = require('../../services/game')
const { createPoller } = require('../../services/poller')

const PHASES = Object.freeze({
  lobby: { label: '等待集结', hint: '全员就绪后，由房主开启游戏。' },
  role_reveal: { label: '确认身份', hint: '私下查看身份，记住情报后确认。' },
  team_building: { label: '领队组队', hint: '领队选择本轮执行任务的玩家。' },
  team_vote: { label: '队伍表决', hint: '全员同时表决，赞成票必须严格过半。' },
  mission_vote: { label: '执行任务', hint: '任务成员私密投票，系统只公开汇总。' },
  assassination: { label: '刺杀时刻', hint: '邪恶方讨论后，由刺客选出梅林。' },
  finished: { label: '本局结束', hint: '查看身份与票型，复盘这场圆桌对决。' }
})

const NOTE_MARKS = Object.freeze({
  unknown: { value: 'unknown', label: '未判断', symbol: '·' },
  trusted: { value: 'trusted', label: '可信', symbol: '○' },
  watch: { value: 'watch', label: '观察', symbol: '◇' },
  suspect: { value: 'suspect', label: '可疑', symbol: '△' }
})

const ROLE_LABELS = Object.freeze({
  merlin: '梅林', percival: '派西维尔', loyal: '忠臣',
  assassin: '刺客', morgana: '莫甘娜', mordred: '莫德雷德',
  oberon: '奥伯伦', minion: '爪牙'
})

function formatClock() {
  const now = new Date()
  return [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((value) => String(value).padStart(2, '0'))
    .join(':')
}

function playerName(player) {
  return (player && player.nickname) || '未命名玩家'
}

function roleKey(role) {
  if (typeof role === 'string') return role
  return role && (role.key || role.role)
}

function normalizeNotes(raw) {
  const notes = {}
  if (Array.isArray(raw)) {
    raw.forEach((item) => {
      const id = item && (item.targetPlayerId || item.playerId || item.id)
      if (id) notes[id] = { mark: item.mark || 'unknown', note: item.note || '' }
    })
    return notes
  }
  if (raw && typeof raw === 'object') {
    Object.keys(raw).forEach((id) => {
      const item = raw[id] || {}
      notes[id] = {
        mark: item.mark || 'unknown',
        note: typeof item.note === 'string' ? item.note : ''
      }
    })
  }
  return notes
}

function voteMap(raw) {
  const result = {}
  if (Array.isArray(raw)) {
    raw.forEach((item) => {
      const id = item && (item.playerId || item.voterId || item.id)
      if (!id) return
      if (typeof item.approved === 'boolean') result[id] = item.approved
      else result[id] = item.vote === 'approve' || item.vote === true
    })
  } else if (raw && typeof raw === 'object') {
    Object.keys(raw).forEach((id) => {
      const value = raw[id]
      result[id] = typeof value === 'object' && value !== null
        ? (typeof value.approved === 'boolean' ? value.approved : value.vote === 'approve')
        : value === true || value === 'approve'
    })
  }
  return result
}

function historyQuestNumber(item, fallback) {
  if (Number.isFinite(Number(item.questIndex))) return Number(item.questIndex) + 1
  if (Number.isFinite(Number(item.questNumber))) return Number(item.questNumber)
  return fallback + 1
}

Page({
  data: {
    roomCode: '',
    loading: true,
    error: '',
    offline: false,
    roomUnavailable: false,
    connectionText: '正在连接圆桌…',
    lastUpdated: '',
    actionBusy: false,
    room: null,
    me: null,
    players: [],
    roleChips: [],
    phase: 'lobby',
    phaseLabel: '',
    phaseHint: '',
    isLobby: true,
    isRoleReveal: false,
    isTeamBuilding: false,
    isTeamVote: false,
    isMissionVote: false,
    isAssassination: false,
    isFinished: false,
    questNumber: 1,
    questTrack: [],
    leaderName: '',
    currentTeam: [],
    selectedTeamIds: [],
    selectedCount: 0,
    canSelectTeam: false,
    canStart: false,
    canViewIdentity: false,
    canTeamVote: false,
    canMissionVote: false,
    canMissionFail: false,
    isAssassin: false,
    assassinationTargetId: '',
    proposalStats: [],
    missionStats: [],
    hasHistory: false,
    revealedRoles: [],
    winnerLabel: '',
    winnerClass: '',
    finishReasonLabel: '',
    markOptions: Object.values(NOTE_MARKS),
    noteOpen: false,
    noteTargetId: '',
    noteTargetName: '',
    noteMark: 'unknown',
    noteText: '',
    noteLength: 0,
    savingNote: false
  },

  onLoad(options) {
    const roomCode = String((options && options.roomCode) || game.getSavedRoomCode() || '').toUpperCase()
    if (!roomCode) {
      wx.reLaunch({ url: '/pages/index/index' })
      return
    }
    this._alive = true
    this._visible = false
    this._requestBarrier = 0
    this._notesByPlayer = {}
    this.setData({ roomCode })
    this.poller = createPoller(
      () => game.getState(roomCode),
      {
        onData: (state) => this.consumeState(state),
        onError: (error, delay) => this.handlePollError(error, delay)
      }
    )
  },

  onShow() {
    this._visible = true
    if (this.poller) this.poller.start(true)
  },

  onHide() {
    this._visible = false
    if (this.poller) this.poller.stop()
  },

  onUnload() {
    this._alive = false
    this._visible = false
    if (this.poller) this.poller.stop()
  },

  onPullDownRefresh() {
    const requestBarrier = this._requestBarrier
    game.getState(this.data.roomCode)
      .then((state) => {
        if (requestBarrier === this._requestBarrier) this.consumeState(state)
      })
      .catch((error) => {
        if (requestBarrier === this._requestBarrier) this.handlePollError(error, 5000)
      })
      .finally(() => wx.stopPullDownRefresh())
  },

  consumeState(state) {
    if (!this._alive || !state || !state.room || !state.me) return
    const room = state.room
    const me = state.me
    const privateView = state.privateView || {}
    const phase = PHASES[room.status] ? room.status : 'lobby'
    const phaseInfo = PHASES[phase]
    const players = Array.isArray(room.players) ? room.players : []
    const playerById = {}
    players.forEach((player) => { playerById[player.id] = player })

    if (Object.prototype.hasOwnProperty.call(privateView, 'playerNotes')) {
      this._notesByPlayer = normalizeNotes(privateView.playerNotes)
    }

    const selectionKey = `${room.questIndex || 0}:${room.proposalAttempt || 0}`
    if (this._selectionKey !== selectionKey || phase !== 'team_building') {
      this._selectionKey = selectionKey
      this._selectedTeamIds = []
    }
    const selectedTeamIds = this._selectedTeamIds || []
    const leaderId = room.leaderPlayerId || (players[room.leaderIndex] && players[room.leaderIndex].id)
    const currentTeamIds = room.currentProposal && Array.isArray(room.currentProposal.teamPlayerIds)
      ? room.currentProposal.teamPlayerIds
      : []
    const ownRoleKey = roleKey(privateView.role)
    const ownCamp = privateView.role && typeof privateView.role === 'object'
      ? privateView.role.camp
      : (['assassin', 'morgana', 'mordred', 'oberon', 'minion'].includes(ownRoleKey) ? 'evil' : 'good')

    const decoratedPlayers = players.map((player) => {
      const note = this._notesByPlayer[player.id] || { mark: 'unknown', note: '' }
      const mark = NOTE_MARKS[note.mark] || NOTE_MARKS.unknown
      return {
        id: player.id,
        nickname: playerName(player),
        initial: [...playerName(player)][0],
        seat: Number(player.seat),
        seatLabel: Number(player.seat) + 1,
        ready: Boolean(player.ready),
        isMe: player.id === me.id,
        isHost: player.id === room.hostPlayerId,
        isLeader: player.id === leaderId,
        selected: selectedTeamIds.includes(player.id),
        onCurrentTeam: currentTeamIds.includes(player.id),
        noteMark: mark.value,
        noteMarkLabel: mark.label,
        noteSymbol: mark.symbol,
        hasNote: Boolean(note.note)
      }
    })

    const proposalStats = this.buildProposalStats(room.proposalHistory, players, playerById)
    const missionStats = this.buildMissionStats(room.questHistory, playerById)
    const isLobby = phase === 'lobby'
    const isRoleReveal = phase === 'role_reveal'
    const isTeamBuilding = phase === 'team_building'
    const isTeamVote = phase === 'team_vote'
    const isMissionVote = phase === 'mission_vote'
    const isAssassination = phase === 'assassination'
    const isFinished = phase === 'finished'
    const desiredPlayers = Number(room.desiredPlayers || players.length)
    const allReady = players.length === desiredPlayers && players.every((player) => player.ready)

    this.setData({
      loading: false,
      error: '',
      offline: false,
      roomUnavailable: false,
      connectionText: '已同步',
      lastUpdated: formatClock(),
      room,
      me,
      players: decoratedPlayers,
      roleChips: this.buildRoleChips(room.roleDeck),
      phase,
      phaseLabel: phaseInfo.label,
      phaseHint: phaseInfo.hint,
      isLobby,
      isRoleReveal,
      isTeamBuilding,
      isTeamVote,
      isMissionVote,
      isAssassination,
      isFinished,
      questNumber: Number(room.questIndex || 0) + 1,
      questTrack: this.buildQuestTrack(room),
      leaderName: playerName(playerById[leaderId]),
      currentTeam: currentTeamIds.map((id) => playerById[id]).filter(Boolean).map((player) => ({
        id: player.id,
        nickname: playerName(player),
        seatLabel: Number(player.seat) + 1
      })),
      selectedTeamIds,
      selectedCount: selectedTeamIds.length,
      canSelectTeam: isTeamBuilding && me.id === leaderId,
      canStart: isLobby && Boolean(me.isHost) && allReady,
      canViewIdentity: !isLobby && !isFinished && Boolean(privateView.role),
      canTeamVote: isTeamVote && !me.hasTeamVoted,
      canMissionVote: isMissionVote && me.isOnMission && !me.hasMissionVoted,
      canMissionFail: isMissionVote && me.isOnMission && ownCamp === 'evil',
      isAssassin: isAssassination && ownRoleKey === 'assassin',
      assassinationTargetId: isAssassination ? this.data.assassinationTargetId : '',
      proposalStats,
      missionStats,
      hasHistory: proposalStats.length > 0 || missionStats.length > 0,
      revealedRoles: isFinished ? this.buildRevealedRoles(room, players, playerById) : [],
      winnerLabel: room.winner === 'good' ? '善良阵营获胜' : (room.winner === 'evil' ? '邪恶阵营获胜' : '游戏结束'),
      winnerClass: room.winner === 'evil' ? 'winner-evil' : 'winner-good',
      finishReasonLabel: this.finishReason(room.finishReason)
    })
  },

  buildRoleChips(deck) {
    if (!Array.isArray(deck)) return []
    return deck.map((entry, index) => {
      const key = roleKey(entry)
      return { id: `${key || 'role'}-${index}`, label: (entry && entry.label) || ROLE_LABELS[key] || '未知角色' }
    })
  },

  buildQuestTrack(room) {
    const history = Array.isArray(room.questHistory) ? room.questHistory : []
    return [0, 1, 2, 3, 4].map((index) => {
      const result = history.find((item) => Number(item.questIndex) === index) || history[index]
      const succeeded = result && (result.succeeded === true || result.outcome === 'success')
      const failed = result && (result.succeeded === false || result.outcome === 'fail' || result.outcome === 'failed')
      return {
        index,
        label: index + 1,
        state: succeeded ? 'success' : (failed ? 'fail' : (Number(room.questIndex) === index ? 'current' : 'pending'))
      }
    })
  },

  buildProposalStats(history, players, playerById) {
    if (!Array.isArray(history)) return []
    return history.map((entry, index) => {
      const votes = voteMap(entry.votes || entry.teamVotes)
      const voteItems = players.map((player) => {
        const hasVote = Object.prototype.hasOwnProperty.call(votes, player.id)
        return {
          playerId: player.id,
          nickname: playerName(player),
          seatLabel: Number(player.seat) + 1,
          vote: hasVote ? (votes[player.id] ? 'approve' : 'reject') : 'missing',
          voteLabel: hasVote ? (votes[player.id] ? '赞成' : '反对') : '未记录'
        }
      })
      const teamIds = entry.teamPlayerIds || (entry.team && entry.team.playerIds) || []
      const attempt = entry.proposalAttempt != null ? entry.proposalAttempt : entry.attempt
      return {
        id: entry.id || `proposal-${index}`,
        questNumber: historyQuestNumber(entry, index),
        attempt: Number.isFinite(Number(attempt)) ? Number(attempt) : 1,
        leaderName: playerName(playerById[entry.leaderPlayerId]),
        teamNames: teamIds.map((id) => playerName(playerById[id])).join('、'),
        approved: entry.approved === true || entry.outcome === 'approved',
        resultLabel: entry.approved === true || entry.outcome === 'approved' ? '通过' : '否决',
        votes: voteItems
      }
    }).reverse()
  },

  buildMissionStats(history, playerById) {
    if (!Array.isArray(history)) return []
    return history.map((entry, index) => {
      const teamIds = entry.teamPlayerIds || (entry.team && entry.team.playerIds) || []
      const failVotes = Number(entry.failVotes != null ? entry.failVotes : (entry.failCount || 0))
      const successVotes = Number(entry.successVotes != null ? entry.successVotes : Math.max(0, teamIds.length - failVotes))
      const succeeded = entry.succeeded === true || entry.outcome === 'success'
      return {
        id: entry.id || `mission-${index}`,
        questNumber: historyQuestNumber(entry, index),
        teamNames: teamIds.map((id) => playerName(playerById[id])).join('、'),
        failVotes,
        successVotes,
        succeeded,
        resultLabel: succeeded ? '任务成功' : '任务失败'
      }
    }).reverse()
  },

  buildRevealedRoles(room, players, playerById) {
    const deck = Array.isArray(room.revealedRoles) ? room.revealedRoles : room.roleDeck
    if (!Array.isArray(deck)) return []
    return deck.map((entry, index) => {
      const role = entry && entry.role ? entry.role : entry
      const key = roleKey(role)
      const id = entry && (entry.playerId || entry.assignedPlayerId)
      const fallbackPlayer = players[index]
      const player = playerById[id] || fallbackPlayer
      return {
        id: id || `${key || 'role'}-${index}`,
        playerName: playerName(player),
        seatLabel: player ? Number(player.seat) + 1 : index + 1,
        roleLabel: (role && role.label) || ROLE_LABELS[key] || '未知角色',
        camp: (role && role.camp) || (['assassin', 'morgana', 'mordred', 'oberon', 'minion'].includes(key) ? 'evil' : 'good')
      }
    })
  },

  finishReason(reason) {
    const labels = {
      merlin_survived: '三次任务成功，刺客未命中梅林',
      merlin_assassinated: '刺客成功找到梅林',
      three_failed_quests: '三次任务失败',
      five_rejected_proposals: '同一任务连续五次组队被否决'
    }
    return labels[reason] || reason || ''
  },

  handlePollError(error, delay) {
    if (!this._alive) return
    const roomUnavailable = ['ROOM_NOT_FOUND', 'NOT_IN_ROOM', 'ROOM_DATA_INCOMPLETE'].includes(error && error.code)
    if (roomUnavailable && this.poller) this.poller.stop()
    this.setData({
      loading: false,
      offline: true,
      roomUnavailable,
      error: error.message || '同步房间失败',
      connectionText: roomUnavailable ? '无法返回该房间' : `连接中断，${Math.ceil(delay / 1000)} 秒后重试`
    })
  },

  retryNow() {
    if (!this.poller) return
    this.poller.stop()
    this.setData({ error: '', offline: false, roomUnavailable: false, connectionText: '正在重连…' })
    this.poller.start(true)
  },

  clearRoomAndReturn() {
    game.clearSavedRoomCode()
    wx.reLaunch({ url: '/pages/index/index' })
  },

  copyRoomCode() {
    wx.setClipboardData({ data: this.data.roomCode })
  },

  openRules() {
    wx.navigateTo({ url: '/pages/rules/rules' })
  },

  openIdentity() {
    wx.navigateTo({ url: `/pages/identity/identity?roomCode=${encodeURIComponent(this.data.roomCode)}` })
  },

  applyAuthoritativeState(state) {
    if (this.poller) this.poller.stop()
    this.consumeState(state)
    if (this._visible && this.poller) this.poller.start(false)
  },

  async perform(task, successTitle) {
    if (this.data.actionBusy) return false
    this._requestBarrier += 1
    this.setData({ actionBusy: true, error: '' })
    try {
      const state = await task()
      if (successTitle) wx.showToast({ title: successTitle, icon: 'success' })
      if (state && state.room && state.me) this.applyAuthoritativeState(state)
      else if (!(state && state.left) && this.poller) this.poller.refresh()
      return true
    } catch (error) {
      this.setData({ error: error.message || '操作失败，请重试' })
      return false
    } finally {
      if (this._alive) this.setData({ actionBusy: false })
    }
  },

  toggleReady() {
    this.perform(() => game.setReady(this.data.roomCode, !this.data.me.ready), this.data.me.ready ? '已取消准备' : '已准备')
  },

  startGame() {
    this.perform(() => game.startGame(this.data.roomCode))
  },

  toggleTeamPlayer(event) {
    if (!this.data.canSelectTeam || this.data.actionBusy) return
    const id = event.currentTarget.dataset.id
    const selected = [...(this._selectedTeamIds || [])]
    const index = selected.indexOf(id)
    if (index >= 0) selected.splice(index, 1)
    else if (selected.length < Number(this.data.room.teamSize)) selected.push(id)
    else {
      wx.showToast({ title: `本轮只需 ${this.data.room.teamSize} 人`, icon: 'none' })
      return
    }
    this._selectedTeamIds = selected
    this.setData({
      selectedTeamIds: selected,
      selectedCount: selected.length,
      players: this.data.players.map((player) => Object.assign({}, player, { selected: selected.includes(player.id) }))
    })
  },

  submitTeam() {
    const selected = this._selectedTeamIds || []
    if (selected.length !== Number(this.data.room.teamSize)) {
      wx.showToast({ title: `请选择 ${this.data.room.teamSize} 名玩家`, icon: 'none' })
      return
    }
    this.perform(() => game.proposeTeam(this.data.roomCode, selected))
  },

  castTeamVote(event) {
    const approved = event.currentTarget.dataset.vote === 'approve'
    this.perform(() => game.castTeamVote(this.data.roomCode, approved), '表决已提交')
  },

  castMissionVote(event) {
    const vote = event.currentTarget.dataset.vote
    const title = vote === 'fail' ? '确认破坏任务？' : '确认提交成功票？'
    wx.showModal({
      title,
      content: '任务票提交后无法修改，结果只公开总数。',
      confirmText: '确认提交',
      success: (result) => {
        if (result.confirm) this.perform(() => game.castMissionVote(this.data.roomCode, vote), '任务票已提交')
      }
    })
  },

  selectAssassinationTarget(event) {
    if (!this.data.isAssassin || this.data.actionBusy) return
    this.setData({ assassinationTargetId: event.currentTarget.dataset.id })
  },

  submitAssassination() {
    const targetId = this.data.assassinationTargetId
    if (!targetId) return
    const target = this.data.players.find((player) => player.id === targetId)
    wx.showModal({
      title: `刺杀 ${playerName(target)}？`,
      content: '目标提交后将立即结算本局。',
      confirmText: '确认刺杀',
      confirmColor: '#b74743',
      success: (result) => {
        if (result.confirm) this.perform(() => game.assassinate(this.data.roomCode, targetId))
      }
    })
  },

  openPlayerNote(event) {
    const id = event.currentTarget.dataset.id
    if (!id || id === this.data.me.id) {
      wx.showToast({ title: '备注用于记录其他玩家', icon: 'none' })
      return
    }
    const target = this.data.players.find((player) => player.id === id)
    const note = this._notesByPlayer[id] || { mark: 'unknown', note: '' }
    this.setData({
      noteOpen: true,
      noteTargetId: id,
      noteTargetName: playerName(target),
      noteMark: note.mark,
      noteText: note.note,
      noteLength: [...note.note].length
    })
  },

  selectNoteMark(event) {
    const mark = event.currentTarget.dataset.mark
    if (NOTE_MARKS[mark]) this.setData({ noteMark: mark })
  },

  onNoteInput(event) {
    const note = event.detail.value || ''
    this.setData({ noteText: note, noteLength: [...note].length })
  },

  closeNote() {
    if (this.data.savingNote) return
    this.setData({ noteOpen: false })
  },

  noop() {},

  async saveNote() {
    if (this.data.savingNote) return
    this._requestBarrier += 1
    this.setData({ savingNote: true })
    try {
      const state = await game.savePlayerNote(
        this.data.roomCode,
        this.data.noteTargetId,
        this.data.noteMark,
        this.data.noteText
      )
      const savedId = this.data.noteTargetId
      if (state && state.room && state.me) {
        this.applyAuthoritativeState(state)
        this.setData({ noteOpen: false })
      } else {
        this._notesByPlayer[savedId] = {
          mark: this.data.noteMark,
          note: this.data.noteText
        }
        const saved = this._notesByPlayer[savedId]
        const mark = NOTE_MARKS[saved.mark]
        this.setData({
          noteOpen: false,
          players: this.data.players.map((player) => player.id === savedId
            ? Object.assign({}, player, {
              noteMark: mark.value,
              noteMarkLabel: mark.label,
              noteSymbol: mark.symbol,
              hasNote: Boolean(saved.note)
            })
            : player)
        })
      }
      wx.showToast({ title: '备注已保存', icon: 'success' })
    } catch (error) {
      wx.showToast({ title: error.message || '保存失败', icon: 'none' })
    } finally {
      if (this._alive) this.setData({ savingNote: false })
    }
  },

  leaveRoom() {
    wx.showModal({
      title: '离开房间？',
      content: this.data.isLobby ? '离开后可使用房间码重新加入。' : '游戏已开始，服务器可能会为你保留座位。',
      confirmText: '离开',
      success: (result) => {
        if (!result.confirm) return
        this.perform(() => game.leaveRoom(this.data.roomCode))
          .then((succeeded) => {
            if (!succeeded) return
            game.clearSavedRoomCode()
            wx.reLaunch({ url: '/pages/index/index' })
          })
      }
    })
  },

  rematch() {
    this.perform(() => game.rematch(this.data.roomCode))
  }
})
