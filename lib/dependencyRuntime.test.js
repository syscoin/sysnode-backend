const geoip = require('geoip-country');
const { Receiver } = require('ws');
const { buildMasternodeSnapshot, countryAlpha3ForHost } = require('./masternodeSnapshot');

test('the real GeoIP runtime still builds country statistics', () => {
  expect(geoip.lookup('8.8.8.8').country).toBe('US');
  expect(countryAlpha3ForHost('8.8.8.8')).toBe('USA');
  const snapshot = buildMasternodeSnapshot({ node: { status: 'ENABLED', address: '8.8.8.8:8369', lastpaidtime: 1 } });
  expect(snapshot.mapData).toEqual({ USA: { masternodes: 1 } });
  expect(snapshot.highestMN).toBe(1);
});

test('the patched WebSocket receiver bounds tiny fragment buffering', async () => {
  const receiver = new Receiver({ isServer: false, maxFragments: 2, maxPayload: 1024 });
  const rejection = new Promise((resolve) => receiver.once('error', resolve));
  receiver.write(Buffer.from([0x02, 0x01, 0x61]));
  receiver.write(Buffer.from([0x00, 0x01, 0x62]));
  receiver.write(Buffer.from([0x80, 0x01, 0x63]));
  expect((await rejection).code).toBe('WS_ERR_TOO_MANY_BUFFERED_PARTS');
});
