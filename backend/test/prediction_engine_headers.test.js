process.env.PREDICTION_ENGINE_AUTH_TOKEN = 'test-engine-token';

const request = require('supertest');
const { app } = require('../src/index');

jest.setTimeout(10000);

describe('Prediction engine proxy headers', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ new_prob: 0.55, cumulative_stake: 10 })
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('market update proxy forwards engine token header', async () => {
    const res = await request(app)
      .post('/api/events/123/update')
      .send({ user_id: 1, stake: 1, target_prob: 0.6 });

    expect(res.statusCode).toBe(200);
    expect(global.fetch).toHaveBeenCalled();

    const [, options] = global.fetch.mock.calls[0];
    expect(options.headers['x-engine-token']).toBe('test-engine-token');
  });
});
