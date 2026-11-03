// Gera o "Pix copia e cola" (BR Code estático, padrão EMV do Banco Central).
'use strict';

function field(id, value) {
  const v = String(value);
  return id + String(v.length).padStart(2, '0') + v;
}

function crc16(str) {
  let crc = 0xffff;
  for (const byte of Buffer.from(str, 'utf8')) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

const clean = (s, n) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^A-Za-z0-9 .\-]/g, '').toUpperCase().slice(0, n) || 'NA';

function brCode({ key, name, city, amountCents, txid }) {
  const account = field('00', 'br.gov.bcb.pix') + field('01', key);
  let payload =
    field('00', '01') +
    field('26', account) +
    field('52', '0000') +
    field('53', '986') +
    (amountCents ? field('54', (amountCents / 100).toFixed(2)) : '') +
    field('58', 'BR') +
    field('59', clean(name, 25)) +
    field('60', clean(city, 15)) +
    field('62', field('05', String(txid || '***').replace(/[^A-Za-z0-9]/g, '').slice(0, 25) || '***')) +
    '6304';
  return payload + crc16(payload);
}

module.exports = { brCode };
