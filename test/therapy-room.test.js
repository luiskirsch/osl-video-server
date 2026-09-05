const test = require('node:test');
const assert = require('node:assert/strict');

const { endTherapyRoom, isMissingRoomError } = require('../services/therapy-room');

test('endTherapyRoom announces the end and deletes the room', async () => {
  const calls = [];
  const client = {
    async sendData(room, payload, kind, options) {
      calls.push({ method: 'sendData', room, payload: JSON.parse(Buffer.from(payload).toString()), kind, options });
    },
    async deleteRoom(room) {
      calls.push({ method: 'deleteRoom', room });
    }
  };

  const result = await endTherapyRoom({ roomName: 'therapy_123', sessionId: '123', client });

  assert.deepEqual(result, { alreadyClosed: false });
  assert.equal(calls[0].method, 'sendData');
  assert.equal(calls[0].payload.t, 'therapy:session-ended');
  assert.equal(calls[0].payload.sessionId, '123');
  assert.deepEqual(calls[0].options, { topic: 'therapy' });
  assert.deepEqual(calls[1], { method: 'deleteRoom', room: 'therapy_123' });
});

test('endTherapyRoom treats a missing room as already closed', async () => {
  const client = {
    async sendData() {
      const error = new Error('room does not exist');
      error.status = 404;
      throw error;
    },
    async deleteRoom() {
      assert.fail('deleteRoom should not be needed after a not-found response');
    }
  };

  const result = await endTherapyRoom({ roomName: 'therapy_missing', sessionId: 'missing', client });
  assert.deepEqual(result, { alreadyClosed: true });
  assert.equal(isMissingRoomError({ code: 'not_found' }), true);
});

test('endTherapyRoom still deletes the room when the announcement fails', async () => {
  let deleted = false;
  const client = {
    async sendData() { throw new Error('announcement failed'); },
    async deleteRoom() { deleted = true; }
  };

  await endTherapyRoom({ roomName: 'therapy_456', sessionId: '456', client });
  assert.equal(deleted, true);
});
