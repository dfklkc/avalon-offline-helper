'use strict'

module.exports = Object.freeze({
  // 留空时使用微信开发者工具当前选中的云环境。
  CLOUD_ENV: '',
  GAME_API_FUNCTION: 'gameApi',
  POLL_INTERVAL_MS: 5000,
  POLL_MAX_DELAY_MS: 30000,
  STORAGE_KEYS: Object.freeze({
    ROOM_CODE: 'avalon:lastRoomCode'
  })
})
