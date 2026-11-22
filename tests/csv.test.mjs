import test from 'node:test';
import assert from 'node:assert/strict';
import {lerCSV, escreverCSV, detectarDelimitador} from '../js/csv.js';

test('detecta ponto e vírgula e vírgula', () => {
  assert.equal(detectarDelimitador('a;b;c\n1;2;3'), ';');
  assert.equal(detectarDelimitador('a,b,c\n1,2,3'), ',');
  assert.equal(detectarDelimitador('"a;x",b,c\n'), ',');
});

test('BOM, CRLF, aspas, campo com quebra de linha e linha original', () => {
  const c = lerCSV('﻿SKU;Desc\r\n001;"Arroz; tipo 1"\r\n002;"Linha\r\ndupla"\r\n\r\n003;"Aspas ""duplas"""\r\n');
  assert.deepEqual(c.cabecalho, ['SKU', 'Desc']);
  assert.deepEqual(c.registros.map(r => r.campos), [['001', 'Arroz; tipo 1'], ['002', 'Linha\r\ndupla'], ['003', 'Aspas "duplas"']]);
  assert.deepEqual(c.registros.map(r => r.linha), [2, 3, 6]);
});

test('escrita e leitura de volta preservam o texto', () => {
  const linhas = [{a: '0001', b: 'x;y', c: 'diz "oi"'}, {a: '0407', b: '', c: 'fim'}];
  const t = escreverCSV(linhas);
  const c = lerCSV(t);
  assert.deepEqual(c.registros.map(r => r.campos), [['0001', 'x;y', 'diz "oi"'], ['0407', '', 'fim']]);
});

test('exportação neutraliza fórmulas (CSV injection)', () => {
  const linhas = [{a: '=HYPERLINK("http://x")', b: '+cmd|\' /C calc\'!A0', c: '-2+3', d: '@SUM(A1)', e: '\t=1', f: '04072100', g: 'texto normal'}];
  const c = lerCSV(escreverCSV(linhas));
  assert.deepEqual(c.registros[0].campos, ["'=HYPERLINK(\"http://x\")", "'+cmd|' /C calc'!A0", "'-2+3", "'@SUM(A1)", "'\t=1", '04072100', 'texto normal']);
});
