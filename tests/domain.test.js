'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  ROLE_DEFINITIONS,
  PLAYER_RULES,
  buildRoleDeck,
  getKnowledge,
  isMissionSuccessful,
  isTeamApproved,
  nextLeaderIndex,
  normalizeNickname,
  normalizeRoomCode
} = require('../cloudfunctions/gameApi/domain')

test('每种人数的经典角色牌数量和阵营数量正确', () => {
  for (let playerCount = 5; playerCount <= 10; playerCount += 1) {
    const deck = buildRoleDeck(playerCount, 'classic')
    const goodCount = deck.filter((role) => ROLE_DEFINITIONS[role].camp === 'good').length
    const evilCount = deck.filter((role) => ROLE_DEFINITIONS[role].camp === 'evil').length
    assert.equal(deck.length, playerCount)
    assert.equal(goodCount, PLAYER_RULES[playerCount].good)
    assert.equal(evilCount, PLAYER_RULES[playerCount].evil)
    assert.equal(deck.filter((role) => role === 'merlin').length, 1)
    assert.equal(deck.filter((role) => role === 'assassin').length, 1)
  }
})

test('7 人以上第 4 轮需要两张失败票', () => {
  assert.equal(PLAYER_RULES[6].failThresholds[3], 1)
  for (let count = 7; count <= 10; count += 1) {
    assert.equal(PLAYER_RULES[count].failThresholds[3], 2)
  }
})

test('组队票必须严格过半，平票否决', () => {
  assert.equal(isTeamApproved({ a: true, b: true, c: false, d: false }), false)
  assert.equal(isTeamApproved({ a: true, b: true, c: true, d: false }), true)
})

test('任务失败阈值正确结算', () => {
  assert.deepEqual(isMissionSuccessful({ a: 'success', b: 'fail' }, 1), {
    succeeded: false,
    failVotes: 1
  })
  assert.deepEqual(isMissionSuccessful({ a: 'success', b: 'fail', c: 'success' }, 2), {
    succeeded: true,
    failVotes: 1
  })
})

test('角色视野遵循梅林、派西维尔和奥伯伦规则', () => {
  const assignments = {
    p1: 'merlin',
    p2: 'percival',
    p3: 'assassin',
    p4: 'morgana',
    p5: 'mordred',
    p6: 'oberon'
  }
  assert.deepEqual(new Set(getKnowledge('p1', assignments).playerIds), new Set(['p3', 'p4', 'p6']))
  assert.deepEqual(new Set(getKnowledge('p2', assignments).playerIds), new Set(['p1', 'p4']))
  assert.deepEqual(new Set(getKnowledge('p3', assignments).playerIds), new Set(['p4', 'p5']))
  assert.deepEqual(getKnowledge('p6', assignments).playerIds, [])
})

test('输入清洗与领队轮换', () => {
  assert.equal(normalizeNickname('  圆桌   一号  '), '圆桌 一号')
  assert.equal(normalizeRoomCode(' abcd23 '), 'ABCD23')
  assert.equal(nextLeaderIndex(4, 5), 0)
  assert.throws(() => normalizeNickname(''))
  assert.throws(() => normalizeRoomCode('O0I1'))
})
