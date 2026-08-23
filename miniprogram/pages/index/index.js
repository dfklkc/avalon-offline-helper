'use strict'

const game = require('../../services/game')

const PLAYER_COUNTS = [5, 6, 7, 8, 9, 10]
const MODES = [
  { value: 'classic', label: '经典模式', hint: '派西维尔与特殊邪恶角色' },
  { value: 'beginner', label: '入门模式', hint: '精简情报，适合第一局' }
]

function roomCodeFromResult(data) {
  if (!data) return ''
  return String(
    data.roomCode ||
    data.code ||
    (data.room && data.room.code) ||
    ''
  ).toUpperCase()
}

Page({
  data: {
    nickname: '',
    playerCounts: PLAYER_COUNTS,
    playerCountIndex: 0,
    modes: MODES,
    modeIndex: 0,
    joinCode: '',
    lastRoomCode: '',
    creating: false,
    joining: false,
    error: ''
  },

  onShow() {
    this.setData({ lastRoomCode: game.getSavedRoomCode() })
  },

  onNicknameInput(event) {
    this.setData({ nickname: event.detail.value, error: '' })
  },

  onJoinCodeInput(event) {
    const value = String(event.detail.value || '').toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, '').slice(0, 6)
    this.setData({ joinCode: value, error: '' })
  },

  onPlayerCountChange(event) {
    this.setData({ playerCountIndex: Number(event.detail.value) })
  },

  onModeChange(event) {
    this.setData({ modeIndex: Number(event.detail.value) })
  },

  validateNickname() {
    const nickname = String(this.data.nickname || '').trim().replace(/\s+/g, ' ')
    if (!nickname) throw new Error('请先输入你的昵称')
    if ([...nickname].length > 10) throw new Error('昵称最多 10 个字符')
    return nickname
  },

  async createRoom() {
    if (this.data.creating || this.data.joining) return
    let nickname
    try {
      nickname = this.validateNickname()
    } catch (error) {
      this.setData({ error: error.message })
      return
    }

    this.setData({ creating: true, error: '' })
    try {
      const data = await game.createRoom({
        nickname,
        desiredPlayers: PLAYER_COUNTS[this.data.playerCountIndex],
        mode: MODES[this.data.modeIndex].value
      })
      const roomCode = roomCodeFromResult(data)
      if (!roomCode) throw new Error('建房成功，但未收到房间码')
      this.enterRoom(roomCode)
    } catch (error) {
      this.setData({ error: error.message || '建房失败，请重试' })
    } finally {
      this.setData({ creating: false })
    }
  },

  async joinRoom() {
    if (this.data.creating || this.data.joining) return
    let nickname
    try {
      nickname = this.validateNickname()
    } catch (error) {
      this.setData({ error: error.message })
      return
    }

    const roomCode = String(this.data.joinCode || '').toUpperCase()
    if (roomCode.length !== 6) {
      this.setData({ error: '请输入 6 位房间码' })
      return
    }

    this.setData({ joining: true, error: '' })
    try {
      const data = await game.joinRoom({ nickname, roomCode })
      this.enterRoom(roomCodeFromResult(data) || roomCode)
    } catch (error) {
      this.setData({ error: error.message || '加入失败，请核对房间码' })
    } finally {
      this.setData({ joining: false })
    }
  },

  returnToRoom() {
    if (!this.data.lastRoomCode) return
    this.enterRoom(this.data.lastRoomCode)
  },

  openRules() {
    wx.navigateTo({ url: '/pages/rules/rules' })
  },

  enterRoom(roomCode) {
    game.saveRoomCode(roomCode)
    wx.navigateTo({
      url: `/pages/room/room?roomCode=${encodeURIComponent(roomCode)}`
    })
  }
})
