import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {criarBase, analisar, analisarLinha, sugerirMapeamento, previaXml, normalizarNcm, normalizarData, vigente, linhaExportacao} from '../js/fiscal.js';
import {lerCSV} from '../js/csv.js';

const D = JSON.parse(fs.readFileSync(new URL('../data.json', import.meta.url), 'utf8'));
const B = criarBase(D);
const base = {data: '2027-03-01', operacao: 'venda'};
const codigos = r => r.achados.map(a => a.codigo);

test('vigência: limites inclusivos e fim nulo', () => {
  assert.equal(vigente('2026-01-01', null, '2026-01-01'), true);
  assert.equal(vigente('2026-01-01', null, '2025-12-31'), false);
  assert.equal(vigente('2026-01-01', '2026-06-30', '2026-06-30'), true);
  assert.equal(vigente('2026-01-01', '2026-06-30', '2026-07-01'), false);
});

test('vigência: data anterior ao início da base fica sem cobertura', () => {
  const r = analisar(B, {ncm: '04072100', data: '2025-12-31', operacao: 'venda', cst: '200', cClassTrib: '200014'});
  assert.equal(r.situacao, 'semCobertura');
  assert.ok(codigos(r).includes('data_sem_cobertura'));
  assert.ok(!codigos(r).includes('cclasstrib_fora_vigencia'));
});

test('vigência: cClassTrib encerrado é apontado na data da operação', () => {
  const t = D.ct['220001'];
  assert.equal(t.fim, '2026-01-01');
  const r = analisar(B, {ncm: '04072100', data: '2026-06-01', operacao: 'venda', cst: '220', cClassTrib: '220001'});
  assert.ok(codigos(r).includes('cclasstrib_fora_vigencia'));
});

test('vigência: regra e exceção valem só dentro do próprio período (base sintética)', () => {
  const S = structuredClone(D);
  S.r = [
    ['0407', [['04079000', '2026-01-01', null]], '200014', 'XV/1', '2026-01-01', '2026-12-31'],
    ['0407', [], '200034', 'VII/1', '2027-01-01', null],
  ];
  const b = criarBase(S);
  const em2026 = analisar(b, {ncm: '04072100', data: '2026-06-01', operacao: 'venda'});
  assert.deepEqual(em2026.enquadramentos.map(e => e.cClassTrib), ['200014']);
  const em2027 = analisar(b, {ncm: '04072100', data: '2027-06-01', operacao: 'venda'});
  assert.deepEqual(em2027.enquadramentos.map(e => e.cClassTrib), ['200034']);
  const excecao = analisar(b, {ncm: '04079000', data: '2026-06-01', operacao: 'venda'});
  assert.equal(excecao.enquadramentos.length, 0);
  assert.equal(excecao.semRegra, true);
});

test('zeros à esquerda: NCM com e sem pontuação, sem virar número', () => {
  assert.equal(normalizarNcm('0407.21.00').valor, '04072100');
  assert.equal(normalizarNcm(' 04072100 ').valor, '04072100');
  assert.equal(normalizarNcm('4072100').problema, 'tamanho');
  const r = analisar(B, {ncm: '4072100', ...base});
  assert.equal(r.situacao, 'divergencia');
  assert.match(r.achados[0].motivo, /zero à esquerda/);
  assert.equal(normalizarNcm('0407.21.0A').problema, 'caracteres');
});

test('zeros à esquerda: CSV preserva SKU, NCM, CST e cClassTrib como texto', () => {
  const c = lerCSV('SKU,NCM,CST,cClassTrib\n000101,04072100,000,000001\n"007",0407.21.00,200,200014\n');
  assert.equal(c.delimitador, ',');
  assert.deepEqual(c.registros[0].campos, ['000101', '04072100', '000', '000001']);
  assert.deepEqual(c.registros[1].campos, ['007', '0407.21.00', '200', '200014']);
  assert.deepEqual(c.registros.map(r => r.linha), [2, 3]);
});

test('compatibilidade CST x cClassTrib e existência na tabela', () => {
  assert.ok(codigos(analisar(B, {ncm: '04072100', cst: '000', cClassTrib: '200014', ...base})).includes('cst_incompativel'));
  assert.ok(codigos(analisar(B, {ncm: '04072100', cst: '200', cClassTrib: '200999', ...base})).includes('cclasstrib_inexistente'));
  assert.ok(codigos(analisar(B, {ncm: '04072100', cst: '999', cClassTrib: '', ...base})).includes('cst_inexistente'));
  assert.ok(codigos(analisar(B, {ncm: '04072100', cst: '', cClassTrib: '200014', ...base})).includes('cst_ausente'));
  assert.ok(codigos(analisar(B, {ncm: '04072100', cst: '200', cClassTrib: '', ...base})).includes('cclasstrib_ausente'));
  const semNfe = Object.entries(D.ct).find(([, t]) => t.nfe === false);
  assert.ok(codigos(analisar(B, {ncm: '04072100', cst: semNfe[1].cst, cClassTrib: semNfe[0], ...base})).includes('cclasstrib_documento'));
  const ok = analisar(B, {ncm: '04072100', cst: '200', cClassTrib: '200014', ...base});
  assert.equal(ok.situacao, 'ok');
});

test('sem regra na base: não presume tributação integral', () => {
  const r = analisar(B, {ncm: '22030000', ...base});
  assert.equal(r.semRegra, true);
  assert.equal(r.escolhido, null);
  const x = previaXml(B, r);
  assert.match(x.texto, /<CST>\[PENDENTE\]<\/CST>/);
  assert.match(x.texto, /<cClassTrib>\[PENDENTE\]<\/cClassTrib>/);
});

test('condição não informada vira pergunta específica, não benefício confirmado', () => {
  const r = analisar(B, {ncm: '01022110', cst: '200', cClassTrib: '200038', ...base});
  assert.equal(r.situacao, 'confirmar');
  assert.deepEqual(r.pendencias.map(p => p.id), ['diferimento_art138']);
  const nao = analisar(B, {ncm: '01022110', cst: '200', cClassTrib: '200038', ...base, respostas: {diferimento_art138: 'nao'}});
  assert.equal(nao.situacao, 'ok');
  const sim = analisar(B, {ncm: '01022110', cst: '200', cClassTrib: '200038', ...base, respostas: {diferimento_art138: 'sim'}});
  assert.equal(sim.situacao, 'divergencia');
  const med = analisar(B, {ncm: '30049099', ...base});
  assert.equal(med.situacao, 'confirmar');
  assert.ok(med.lacuna && /Anvisa/.test(med.lacuna.titulo));
});

test('operação define o comprador: venda comum exclui o benefício de órgão público', () => {
  const comum = analisar(B, {ncm: '84212990', ...base});
  assert.equal(comum.enquadramentos.find(e => e.cClassTrib === '200005').estado, 'excluido');
  const pub = analisar(B, {ncm: '84212990', data: '2027-03-01', operacao: 'venda_publica'});
  assert.equal(pub.enquadramentos.find(e => e.cClassTrib === '200005').estado, 'aplicavel');
  assert.equal(analisar(B, {ncm: '84212990', data: '2027-03-01', operacao: 'exportacao'}).situacao, 'semCobertura');
});

test('equivalência: consulta individual e linha do CSV dão o mesmo diagnóstico', () => {
  const csv = lerCSV(fs.readFileSync(new URL('../exemplos/cadastro-demonstracao.csv', import.meta.url), 'utf8'));
  const mapa = sugerirMapeamento(csv.cabecalho);
  const lote = {data: '2026-12-01', operacao: 'venda'};
  for (const reg of csv.registros) {
    const [, , ncm, cst, cClassTrib, operacao, data] = reg.campos;
    const lin = analisarLinha(B, reg.campos, mapa, lote);
    const uni = analisar(B, {ncm, cst, cClassTrib, operacao: operacao || lote.operacao, data: data || lote.data});
    assert.deepEqual(lin, uni, `linha ${reg.linha}`);
    assert.equal(linhaExportacao(reg, mapa, lin)['Linha no arquivo'], String(reg.linha));
  }
  // amostra ampla da tabela NCM, sem códigos e com códigos
  for (const [ncm] of D.ncm.filter((_, i) => i % 37 === 0)) {
    for (const [cst, ct] of [['', ''], ['000', '000001'], ['200', '200034']]) {
      const linha = analisarLinha(B, [ncm, cst, ct], {ncm: 0, cst: 1, cClassTrib: 2, sku: -1, descricao: -1, operacao: -1, data: -1}, base);
      assert.deepEqual(linha, analisar(B, {ncm, cst, cClassTrib: ct, ...base}));
    }
  }
});

test('demonstração cobre os casos pedidos', () => {
  const csv = lerCSV(fs.readFileSync(new URL('../exemplos/cadastro-demonstracao.csv', import.meta.url), 'utf8'));
  const mapa = sugerirMapeamento(csv.cabecalho);
  const sit = Object.fromEntries(csv.registros.map(r => [r.campos[0], analisarLinha(B, r.campos, mapa, {data: '2026-12-01', operacao: 'venda'})]));
  assert.equal(sit['000101'].situacao, 'ok');
  assert.ok(codigos(sit['000102']).includes('ncm_malformado'));
  assert.ok(codigos(sit['000103']).includes('cst_incompativel'));
  assert.equal(sit['000105'].situacao, 'confirmar');
});

test('datas aceitas', () => {
  assert.equal(normalizarData('01/12/2026'), '2026-12-01');
  assert.equal(normalizarData('2026-12-01'), '2026-12-01');
  assert.equal(normalizarData('31/02/2026'), null);
});
