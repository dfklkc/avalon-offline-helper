'use strict'

const {
  GAME_API_FUNCTION,
  STORAGE_KEYS
} = require('../config/index')

function getErrorMessage(payload, fallback) {
  if (!payload) return fallback
  if (typeof payload === 'string') return payload
  if (typeof payload.message === 'string') return payload.message
  if (typeof payload.error === 'string') return payload.error
  if (payload.error && typeof payload.error.message === 'string') return payload.error.message
  return fallback
}

function call(action, payload) {
  if (!wx.cloud) {
    return Promise.reject(new Error('当前微信基础库不支持云开发'))
  }

  return wx.cloud.callFunction({
    name: GAME_API_FUNCTION,
    data: Object.assign({ action }, payload || {})
  }).then((response) => {
    const result = response && response.result
    if (!result || result.ok !== true) {
      const error = new Error(getErrorMessage(result, '服务暂时不可用，请稍后重试'))
      error.code = result && (result.code || (result.error && result.error.code))
      error.fromGameApi = true
      throw error
    }
    return result.data
  }).catch((error) => {
    if (error && error.fromGameApi) throw error
    const networkError = new Error('网络异常，请检查连接后重试')
    networkError.code = 'NETWORK_ERROR'
    throw networkError
  })
}

function withRoom(action, roomCode, payload) {
  return call(action, Object.assign({ roomCode }, payload || {}))
}

function saveRoomCode(roomCode) {
  if (roomCode) wx.setStorageSync(STORAGE_KEYS.ROOM_CODE, String(roomCode).toUpperCase())
}

function getSavedRoomCode() {
  return String(wx.getStorageSync(STORAGE_KEYS.ROOM_CODE) || '').toUpperCase()
}

function clearSavedRoomCode() {
  wx.removeStorageSync(STORAGE_KEYS.ROOM_CODE)
}

module.exports = {
  createRoom(payload) {
    return call('createRoom', payload)
  },
  joinRoom(payload) {
    return call('joinRoom', payload)
  },
  getState(roomCode) {
    return withRoom('getState', roomCode)
  },
  setReady(roomCode, ready) {
    return withRoom('setReady', roomCode, { ready })
  },
  startGame(roomCode) {
    return withRoom('startGame', roomCode)
  },
  acknowledgeRole(roomCode) {
    return withRoom('acknowledgeRole', roomCode)
  },
  proposeTeam(roomCode, teamPlayerIds) {
    return withRoom('proposeTeam', roomCode, { teamPlayerIds })
  },
  castTeamVote(roomCode, approved) {
    return withRoom('castTeamVote', roomCode, { approved })
  },
  castMissionVote(roomCode, vote) {
    return withRoom('castMissionVote', roomCode, { vote })
  },
  assassinate(roomCode, targetPlayerId) {
    return withRoom('assassinate', roomCode, { targetPlayerId })
  },
  savePlayerNote(roomCode, targetPlayerId, mark, note) {
    return withRoom('savePlayerNote', roomCode, { targetPlayerId, mark, note })
  },
  leaveRoom(roomCode) {
    return withRoom('leaveRoom', roomCode)
  },
  rematch(roomCode) {
    return withRoom('rematch', roomCode)
  },
  saveRoomCode,
  getSavedRoomCode,
  clearSavedRoomCode
}
