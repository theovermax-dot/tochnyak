import test from 'node:test';
import assert from 'node:assert/strict';
import { regularScore, mapMatch } from '../src/footballData.js';

test('для овертайма и пенальти берётся счёт основного времени', () => {
  const score = { duration: 'PENALTY_SHOOTOUT', fullTime: { home: 5, away: 4 }, regularTime: { home: 1, away: 1 } };
  assert.deepEqual(regularScore(score), { home: 1, away: 1 });
  assert.deepEqual(regularScore({ fullTime: { home: 2, away: 0 } }), { home: 2, away: 0 });
  assert.equal(regularScore({ fullTime: { home: null, away: null } }), null);
});

test('матч без известных команд пропускается', () => {
  assert.equal(mapMatch({ id: 1, homeTeam: { name: null }, awayTeam: { name: 'X' } }), null);
});

test('если нет сокращения, берутся первые буквы названия', () => {
  const m = mapMatch({
    id: 5, utcDate: '2026-11-01T15:00:00Z', status: 'TIMED',
    competition: { code: 'DED', name: 'Eredivisie' },
    homeTeam: { name: 'Go Ahead Eagles', shortName: 'Go Ahead', tla: null },
    awayTeam: { name: 'AFC Ajax', shortName: 'Ajax', tla: 'AJA' },
    score: { fullTime: { home: null, away: null } }
  });
  assert.equal(m.homeTla, 'GOA');
  assert.equal(m.awayTla, 'AJA');
});

test('названия клубов: вместо сленга полные', async () => {
  const { teamName } = await import('../src/teams.js');
  assert.equal(teamName('Atleti', 'Club Atlético de Madrid'), 'Atlético Madrid');
  assert.equal(teamName('Barça', 'FC Barcelona'), 'Barcelona');
  assert.equal(teamName('Man United', 'Manchester United FC'), 'Manchester United');
  assert.equal(teamName('Spurs', 'Tottenham Hotspur FC'), 'Tottenham');
  assert.equal(teamName('Real Madrid', 'Real Madrid CF'), 'Real Madrid');
  assert.equal(teamName('', 'Arsenal FC'), 'Arsenal');
});
