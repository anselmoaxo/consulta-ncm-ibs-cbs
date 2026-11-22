// Motor fiscal único da consulta e da auditoria de cadastro (IBS/CBS).
// Não acessa a página nem a rede: recebe o data.json já carregado e devolve o diagnóstico.
// A mesma função (analisar) responde a consulta de um produto e cada linha do CSV,
// então o mesmo produto com os mesmos dados recebe o mesmo diagnóstico nos dois fluxos.

export const SITUACOES = {
  divergencia: 'Divergência encontrada',
  confirmar: 'Requer confirmação',
  semCobertura: 'Sem cobertura',
  ok: 'Sem divergência nas verificações executadas',
};
export const ORDEM = ['divergencia', 'confirmar', 'semCobertura', 'ok'];
const PESO = Object.fromEntries(ORDEM.map((k, i) => [k, i]));
export const SEM_REGRA = 'Sem regra localizada na base consultada';
const TRIBUTOS = ['CBS', 'IBSUF', 'IBSMun'];

// ---------- normalização (nunca converte para número: zeros à esquerda ficam) ----------
const texto = v => (v == null ? '' : String(v)).trim();

export function normalizarNcm(v) {
  const original = texto(v);
  if (!original) return {original, valor: '', problema: 'ausente'};
  if (!/^[\d.\s-]+$/.test(original)) return {original, valor: '', problema: 'caracteres'};
  const valor = original.replace(/\D/g, '');
  if (valor.length !== 8) return {original, valor, problema: 'tamanho'};
  return {original, valor, problema: null};
}

export function normalizarCodigo(v, tamanho) {
  const original = texto(v);
  if (!original) return {original, valor: '', problema: 'ausente'};
  if (!/^\d+$/.test(original)) return {original, valor: '', problema: 'caracteres'};
  if (original.length !== tamanho) return {original, valor: original, problema: 'tamanho'};
  return {original, valor: original, problema: null};
}

export function normalizarData(v) {
  const s = texto(v);
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  let iso = m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  if (!iso) { m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); if (m) iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
  if (!iso) return null;
  const d = new Date(iso + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === iso ? iso : null;
}

const semAcento = s => texto(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function normalizarOperacao(base, v) {
  const s = semAcento(v).replace(/[\s_-]+/g, ' ');
  if (!s) return null;
  for (const [k, op] of Object.entries(base.ops)) {
    if (s === k.replace(/_/g, ' ') || s === semAcento(op.nome)) return k;
  }
  return undefined; // informada, mas não reconhecida
}

// ---------- datas e vigência ----------
// Vigência fechada nos dois lados: vale de "ini" até "fim" (inclusive). fim nulo = sem término.
export const vigente = (ini, fim, data) => (!ini || ini <= data) && (!fim || data <= fim);
export const fmtData = iso => (iso ? iso.split('-').reverse().join('/') : '');
export const fmtNcm = c => c.length <= 4 ? c : c.length === 5 ? `${c.slice(0, 4)}.${c[4]}` : `${c.slice(0, 4)}.${c.slice(4, 6)}${c.length > 6 ? '.' + c.slice(6) : ''}`;
const limpa = s => texto(s).replace(/<[^>]+>/g, '').replace(/^[\s-]+/, '');

// ---------- base ----------
export function criarBase(D) {
  const fonte = id => D.fontes.find(f => f.id === id) || {};
  return {
    D,
    ncm: new Map(D.ncm),
    ops: D.cond.operacoes,
    cond: D.cond.condicoes,
    condCt: D.cond.porClassTrib,
    itensRestritos: new Set(D.cond.itensRestritos),
    lacunas: D.cond.lacunas,
    calc: fonte('calculadora-offline-V0059'),
    tab: fonte('it-2025.002-v1.60-cclasstrib'),
    sefaz: fonte('sefaz-consulta-tributacao'),
  };
}

export function caminho(base, c) {
  return [2, 4, 5, 6, 7].map(n => c.slice(0, n)).filter(k => base.D.tree[k]).map(k => [k, limpa(base.D.tree[k])]);
}

const casa = (c, regra, data) => c.startsWith(regra[0]) && !regra[1].some(([e, ini, fim]) => c.startsWith(e) && vigente(ini, fim, data));

function reducoes(t, data) {
  const r = {};
  for (const [trib, p, ini, fim] of t.red) if (vigente(ini, fim, data)) r[trib] = p;
  return r;
}

export function regimeDe(t, red) {
  const vals = TRIBUTOS.map(k => red[k] ?? 0);
  const p = Math.max(...vals);
  if (t.cst === '515') return `Diferimento com redução de ${p.toLocaleString('pt-BR')}%`;
  if (t.cst === '510') return 'Diferimento';
  if (vals.every(v => v >= 100)) return 'Alíquota zero';
  if (p > 0) return `Redução de ${p.toLocaleString('pt-BR')}%`;
  return t.nome;
}

function refTabela(base, codigo) {
  const t = base.D.ct[codigo];
  const partes = [`Tabela cClassTrib, IT 2025.002 ${base.tab.versao || ''}`.trim()];
  if (t && t.pub) partes.push(`publicada em ${fmtData(t.pub)}`);
  if (t) partes.push(`código vigente desde ${fmtData(t.ini)}${t.fim ? ` até ${fmtData(t.fim)}` : ''}`);
  return partes.join(', ');
}

function refLei(t) {
  return t.art ? `LC 214/2025, ${t.art}` : 'LC 214/2025';
}

// ---------- análise ----------
/**
 * entrada: {ncm, data, operacao, cst, cClassTrib, respostas}
 *  - ncm, cst e cClassTrib como texto (como vieram do ERP)
 *  - data em AAAA-MM-DD ou DD/MM/AAAA
 *  - operacao: chave de base.ops (venda, venda_publica...) ou texto
 *  - respostas: {idCondicao: 'sim' | 'nao'} para perguntas já respondidas
 */
export function analisar(base, entrada) {
  const D = base.D;
  const achados = [];
  const add = (situacao, codigo, motivo, acao, referencia = '') => achados.push({situacao, codigo, motivo, acao, referencia});
  const n = normalizarNcm(entrada.ncm);
  const cstIn = normalizarCodigo(entrada.cst, 3);
  const ctIn = normalizarCodigo(entrada.cClassTrib, 6);
  const data = normalizarData(entrada.data);
  const opChave = base.ops[entrada.operacao] ? entrada.operacao : normalizarOperacao(base, entrada.operacao);
  const op = opChave ? base.ops[opChave] : null;
  const respostas = {...(entrada.respostas || {})};
  if (op && op.responde) Object.assign(respostas, op.responde);

  const r = {
    entrada: {ncm: n.valor, ncmRecebido: n.original, data, dataRecebida: texto(entrada.data), operacao: opChave || null,
      operacaoRecebida: texto(entrada.operacao), cst: cstIn.original, cClassTrib: ctIn.original},
    produto: null, enquadramentos: [], pendencias: [], avisos: [], semRegra: false, lacuna: null,
    achados, situacao: 'ok', referencias: [],
  };

  // 1) NCM
  const refNcm = `Tabela NCM do Siscomex de ${fmtData(D.versoes.ncm.slice(0, 10))}`;
  if (n.problema === 'ausente') add('divergencia', 'ncm_ausente', 'NCM não informado.', 'Preencha o NCM de 8 dígitos no cadastro do produto.', refNcm);
  else if (n.problema === 'caracteres') add('divergencia', 'ncm_malformado', `NCM "${n.original}" tem caracteres que não são dígitos.`, 'Corrija o NCM no cadastro: só números, com ou sem pontos.', refNcm);
  else if (n.problema === 'tamanho') {
    const dica = n.valor.length === 7 ? ` Se o arquivo passou pelo Excel, o zero à esquerda pode ter sido perdido (0${n.valor}).` : '';
    add('divergencia', 'ncm_malformado', `NCM "${n.original}" tem ${n.valor.length} dígitos; o NCM tem 8.${dica}`, 'Corrija o NCM no cadastro e exporte o arquivo com a coluna como texto.', refNcm);
  } else if (!base.ncm.has(n.valor)) {
    add('divergencia', 'ncm_inexistente', `NCM ${fmtNcm(n.valor)} não consta da tabela NCM usada.`, 'Confira os dígitos na Nomenclatura do Siscomex e corrija o cadastro.', `${refNcm}. A tabela é um retrato dessa data, sem histórico de vigência por código.`);
  } else {
    r.produto = {descricao: limpa(base.ncm.get(n.valor)).replace(/\.\s*$/, ''), caminho: caminho(base, n.valor)};
  }

  const primeiroDia = Object.values(D.cst).reduce((m, c) => (!m || c.ini < m ? c.ini : m), null);
  // 2) Códigos informados: formato, existência na tabela e compatibilidade CST x cClassTrib
  const refCt = refTabela(base, ctIn.valor);
  let ctInfo = null;
  if (cstIn.problema === 'caracteres' || cstIn.problema === 'tamanho') add('divergencia', 'cst_malformado', `CST "${cstIn.original}" fora do formato de 3 dígitos.`, 'Corrija o CST de IBS/CBS no cadastro (ex.: 000, 200, 515).', 'Tabela de CST de IBS/CBS, IT 2025.002');
  else if (cstIn.valor && !D.cst[cstIn.valor]) add('divergencia', 'cst_inexistente', `CST ${cstIn.valor} não consta da tabela de CST de IBS/CBS.`, 'Use um CST da tabela oficial.', 'Tabela de CST de IBS/CBS, IT 2025.002');
  if (ctIn.problema === 'caracteres' || ctIn.problema === 'tamanho') {
    const dica = ctIn.problema === 'tamanho' && ctIn.original.length === 5 ? ` Pode ter perdido o zero à esquerda (0${ctIn.original}).` : '';
    add('divergencia', 'cclasstrib_malformado', `cClassTrib "${ctIn.original}" fora do formato de 6 dígitos.${dica}`, 'Corrija o cClassTrib no cadastro.', `Tabela cClassTrib, IT 2025.002 ${base.tab.versao || ''}`.trim());
  } else if (ctIn.valor) {
    ctInfo = D.ct[ctIn.valor] || null;
    if (!ctInfo) add('divergencia', 'cclasstrib_inexistente', `cClassTrib ${ctIn.valor} não consta da tabela de classificação tributária.`, 'Use um cClassTrib da tabela oficial.', `Tabela cClassTrib, IT 2025.002 ${base.tab.versao || ''}`.trim());
    else {
      if (ctInfo.nfe === false) add('divergencia', 'cclasstrib_documento', `cClassTrib ${ctIn.valor} não é previsto para NF-e.`, 'Escolha um cClassTrib aceito em NF-e (modelo 55).', refCt);
      if (cstIn.valor && D.cst[cstIn.valor] && ctInfo.cst !== cstIn.valor) add('divergencia', 'cst_incompativel', `cClassTrib ${ctIn.valor} pertence ao CST ${ctInfo.cst}, mas o cadastro informa CST ${cstIn.valor}.`, `Ajuste o CST para ${ctInfo.cst} ou revise o cClassTrib.`, refCt);
      if (data && data >= primeiroDia && !vigente(ctInfo.ini, ctInfo.fim, data)) add('divergencia', 'cclasstrib_fora_vigencia', `cClassTrib ${ctIn.valor} não está vigente em ${fmtData(data)} (vigência ${fmtData(ctInfo.ini)}${ctInfo.fim ? ' a ' + fmtData(ctInfo.fim) : ' em diante'}).`, 'Use um código vigente na data da operação.', refCt);
    }
  }
  if (!cstIn.valor && ctIn.valor && !ctIn.problema && ctInfo) add('divergencia', 'cst_ausente', `cClassTrib informado sem CST.`, `Preencha o CST ${ctInfo.cst}, que é o do cClassTrib ${ctIn.valor}.`, refCt);
  if (cstIn.valor && !cstIn.problema && !ctIn.valor) add('divergencia', 'cclasstrib_ausente', `CST ${cstIn.valor} informado sem cClassTrib.`, 'Preencha o cClassTrib de 6 dígitos; os três primeiros são o CST.', `Tabela cClassTrib, IT 2025.002 ${base.tab.versao || ''}`.trim());

  // 3) Data e operação
  if (!data) {
    add('divergencia', 'data_invalida', r.entrada.dataRecebida ? `Data da operação "${r.entrada.dataRecebida}" inválida.` : 'Data da operação não informada.', 'Informe a data no formato DD/MM/AAAA ou AAAA-MM-DD, na linha ou para o lote.', '');
  } else if (data < primeiroDia) {
    add('semCobertura', 'data_sem_cobertura', `Em ${fmtData(data)} ainda não havia CST nem cClassTrib de IBS/CBS vigentes na base (a primeira vigência é ${fmtData(primeiroDia)}).`, 'Use uma data a partir do início da vigência.', `${refTabela(base, '000001')}`);
  }
  if (opChave === undefined) add('semCobertura', 'operacao_desconhecida', `Operação "${r.entrada.operacaoRecebida}" não reconhecida.`, `Use uma destas: ${Object.values(base.ops).map(o => o.nome).join('; ')}.`, '');
  else if (!op) add('divergencia', 'operacao_ausente', 'Operação não informada.', 'Informe a operação na linha ou para o lote.', '');
  else if (op.semCobertura) add('semCobertura', 'operacao_sem_cobertura', `A operação "${op.nome}" está fora da cobertura desta versão, que analisa vendas no mercado interno.`, 'Confirme o enquadramento dessa operação com o responsável fiscal.', '');

  const podeAnalisar = r.produto && data && data >= primeiroDia && op && !op.semCobertura;
  if (!podeAnalisar) return fechar(base, r);

  // 4) Enquadramentos que alcançam o NCM na data
  const c = n.valor;
  const porCt = new Map();
  for (const regra of D.r) {
    const [, , ct, item, ini, fim] = regra;
    if (!vigente(ini, fim, data) || !casa(c, regra, data)) continue;
    const t = D.ct[ct];
    if (!t || !vigente(t.ini, t.fim, data)) continue;
    if (!porCt.has(ct)) porCt.set(ct, {regras: [], itens: []});
    const e = porCt.get(ct);
    e.regras.push({prefixo: regra[0], ini, fim});
    if (item && !e.itens.includes(item)) e.itens.push(item);
  }
  for (const [ct, {regras, itens}] of porCt) {
    const t = D.ct[ct];
    const red = reducoes(t, data);
    const ids = [...(base.condCt[ct] || [])];
    const itensTxt = itens.map(i => ({item: i, texto: (D.anx[i] || [''])[0], restrito: base.itensRestritos.has(i)}));
    // Se todos os itens que alcançam o NCM têm destinação/restrição no texto, o NCM não basta.
    if (itensTxt.length && itensTxt.every(i => i.restrito)) ids.push('item:' + ct);
    const condicoes = ids.map(id => {
      if (id.startsWith('item:')) return {id, exige: 'sim', pergunta: `O produto corresponde ao texto do item ${itens.join(' ou ')} do anexo, inclusive a destinação indicada?`,
        porque: 'O texto do item traz destinação ou restrição; o NCM sozinho não garante o enquadramento.', origem: 'pergunta', resposta: respostas[id] || null};
      const neg = id.startsWith('!'), bid = neg ? id.slice(1) : id, cd = base.cond[bid];
      return {id: bid, exige: neg ? 'nao' : 'sim', pergunta: cd.pergunta, porque: cd.porque, origem: cd.origem, resposta: respostas[bid] || null};
    });
    const estado = condicoes.some(x => x.resposta && x.resposta !== x.exige) ? 'excluido' : condicoes.some(x => !x.resposta) ? 'pendente' : 'aplicavel';
    const regraIni = regras.map(x => x.ini).sort()[0];
    r.enquadramentos.push({
      cClassTrib: ct, cst: t.cst, nome: t.nome, desc: t.desc, regime: regimeDe(t, red), red,
      itens: itensTxt, art: t.art, url: t.url, lei: (t.lei.find(l => vigente(l[2], l[3], data)) || t.lei[0] || [])[1] || '',
      condicoes, estado,
      fonte: `${refTabela(base, ct)}. Regra NCM da Calculadora da Receita ${base.calc.versao} (dados de ${fmtData(base.calc.data)}), vigente desde ${fmtData(regraIni)}. ${refLei(t)}`,
    });
  }
  const ordem = {aplicavel: 0, pendente: 1, excluido: 2};
  r.enquadramentos.sort((a, b) => ordem[a.estado] - ordem[b.estado] || a.cClassTrib.localeCompare(b.cClassTrib));

  // 5) Lacunas conhecidas da base (ex.: medicamentos dependem de registro na Anvisa)
  for (const [id, lac] of Object.entries(base.lacunas)) {
    if (lac.posicoes.some(p => c.startsWith(p))) {
      r.lacuna = {id, titulo: lac.titulo, pergunta: lac.pergunta, porque: lac.porque, classTrib: lac.classTrib.filter(k => D.ct[k]).map(k => ({cClassTrib: k, nome: D.ct[k].nome, art: D.ct[k].art, url: D.ct[k].url}))};
    }
  }

  // 6) Imposto Seletivo (fora do escopo: só avisa, com a data de início da regra)
  const isHits = D.is.filter(regra => casa(c, regra, data));
  if (isHits.length) {
    const ini = isHits.map(x => x[3]).sort()[0];
    const vale = isHits.some(x => vigente(x[3], x[4], data));
    r.avisos.push(vale ? `Este NCM consta das regras do Imposto Seletivo vigentes em ${fmtData(data)}. O Seletivo não muda CST e cClassTrib de IBS/CBS e não é analisado nesta versão.`
      : `Este NCM consta das regras do Imposto Seletivo a partir de ${fmtData(ini)}. Não muda CST e cClassTrib de IBS/CBS.`);
  }

  // 7) Pendências: cada condição sem resposta, com os enquadramentos que dependem dela
  const pend = new Map();
  for (const e of r.enquadramentos) for (const cd of e.condicoes) if (!cd.resposta) {
    if (!pend.has(cd.id)) pend.set(cd.id, {id: cd.id, pergunta: cd.pergunta, porque: cd.porque, origem: cd.origem, enquadramentos: []});
    pend.get(cd.id).enquadramentos.push(e.cClassTrib);
  }
  r.pendencias = [...pend.values()];
  const aplic = r.enquadramentos.filter(e => e.estado === 'aplicavel');
  const pendentes = r.enquadramentos.filter(e => e.estado === 'pendente');
  r.semRegra = !r.enquadramentos.length && !r.lacuna;

  // 8) Diagnóstico do enquadramento (com ou sem código informado)
  const refBase = `Regras NCM da Calculadora da Receita ${base.calc.versao} (dados de ${fmtData(base.calc.data)}) e ${`IT 2025.002 ${base.tab.versao}`}`;
  const lista = es => es.map(e => `${e.cClassTrib} (${e.regime})`).join(', ');
  const informado = ctIn.valor && ctInfo && !ctIn.problema ? ctIn.valor : null;
  if (r.lacuna) {
    add('confirmar', 'lacuna_' + r.lacuna.id, `${r.lacuna.titulo}. ${r.lacuna.porque}`, `Confirme: ${r.lacuna.pergunta}`, r.lacuna.classTrib.map(x => `cClassTrib ${x.cClassTrib}, LC 214/2025, ${x.art}`).join('; '));
  }
  if (informado) {
    const e = r.enquadramentos.find(x => x.cClassTrib === informado);
    if (e && e.estado === 'excluido') {
      const cd = e.condicoes.find(x => x.resposta && x.resposta !== x.exige);
      add('divergencia', 'condicao_nao_atendida', `cClassTrib ${informado} não se aplica: "${cd.pergunta}" foi respondida com ${cd.resposta === 'sim' ? 'sim' : 'não'}.`, aplic.length === 1 ? `Para esta operação, a base indica ${lista(aplic)}.` : 'Revise o cClassTrib para esta operação.', e.fonte);
    } else if (e && e.estado === 'pendente') {
      add('confirmar', 'condicao_pendente', `cClassTrib ${informado} depende de condição não informada: ${e.condicoes.filter(x => !x.resposta).map(x => x.pergunta).join(' ')}`, 'Confirme a condição com o responsável fiscal antes da implantação.', e.fonte);
    } else if (e) {
      const outros = aplic.filter(x => x.cClassTrib !== informado);
      const pend = pendentes.filter(x => x.cClassTrib !== informado);
      if (outros.length) add('confirmar', 'multiplos', `Além do ${informado}, o NCM também se enquadra em ${lista(outros)}.`, 'Confirme com o responsável fiscal qual enquadramento corresponde ao produto.', e.fonte);
      if (pend.length) add('confirmar', 'alternativa_pendente', `Há enquadramento alternativo que depende de condição não informada: ${lista(pend)}. ${r.pendencias.filter(p => p.enquadramentos.some(k => pend.some(x => x.cClassTrib === k))).map(p => p.pergunta).join(' ')}`, 'Responda à pergunta para confirmar se o cadastro deve mudar.', pend[0].fonte);
      if (!outros.length && !pend.length) add('ok', 'confere', `cClassTrib ${informado} confere com a regra da base para o NCM em ${fmtData(data)}.`, 'Nenhuma ação.', e.fonte);
    } else if (ctInfo.anexo && ctInfo.nomencl && ctInfo.nomencl.includes('NCM')) {
      add('divergencia', 'anexo_nao_alcanca', `cClassTrib ${informado} vale para NCMs do Anexo ${ctInfo.anexo} da LC 214/2025, e o NCM ${fmtNcm(c)} não está nesse anexo na data.`, r.enquadramentos.length ? `A base indica para este NCM: ${lista(r.enquadramentos)}.` : 'Revise o cClassTrib com o responsável fiscal.', refTabela(base, informado));
    } else if (informado === '000001') {
      if (aplic.length) add('divergencia', 'reducao_ignorada', `O cadastro usa tributação integral (000001), mas o NCM consta do anexo de ${lista(aplic)}.`, 'Revise o cadastro com o responsável fiscal: o produto pode ter direito ao tratamento do anexo.', aplic[0].fonte);
      else if (pendentes.length) add('confirmar', 'reducao_condicional', `O cadastro usa tributação integral (000001), mas o NCM tem enquadramento condicionado: ${lista(pendentes)}.`, `Responda: ${r.pendencias.map(p => p.pergunta).join(' ')}`, pendentes[0].fonte);
      else if (!r.lacuna) add('ok', 'sem_regra', `${SEM_REGRA} para o NCM ${fmtNcm(c)}. A base não traz redução por anexo para este NCM, mas também não confirma a tributação integral: imunidade, monofasia e outras hipóteses dependem da operação.`, 'Nenhuma divergência apontada pela base; mantenha a conferência do fiscal.', refBase);
    } else {
      add('semCobertura', 'codigo_sem_cobertura', `cClassTrib ${informado} (${ctInfo.nome}) depende de condições que não são verificáveis pelo NCM nesta base.`, 'Confirme o enquadramento com o responsável fiscal.', refTabela(base, informado));
    }
  } else if (!ctIn.valor) {
    if (aplic.length === 1 && !pendentes.length) add('ok', 'determinado', `A base indica ${lista(aplic)} para o NCM ${fmtNcm(c)} nesta operação. CST e cClassTrib não informados no cadastro.`, `Preencha CST ${aplic[0].cst} e cClassTrib ${aplic[0].cClassTrib}.`, aplic[0].fonte);
    else if (aplic.length > 1) add('confirmar', 'multiplos', `O NCM se enquadra em mais de um tratamento: ${lista(aplic)}.`, 'Confirme com o responsável fiscal qual corresponde ao produto e à operação.', aplic[0].fonte);
    else if (!aplic.length && pendentes.length) add('confirmar', 'condicao_pendente', `O enquadramento depende de condição não informada: ${lista(pendentes)}.`, `Responda: ${r.pendencias.map(p => p.pergunta).join(' ')}`, pendentes[0].fonte);
    if (aplic.length === 1 && pendentes.length) add('confirmar', 'alternativa_pendente', `A base indica ${lista(aplic)}, mas há alternativa condicionada: ${lista(pendentes)}.`, `Responda: ${r.pendencias.map(p => p.pergunta).join(' ')}`, pendentes[0].fonte);
    if (r.semRegra) add('ok', 'sem_regra', `${SEM_REGRA} para o NCM ${fmtNcm(c)}. Isso não confirma tributação integral: outras hipóteses dependem da operação.`, 'Defina CST e cClassTrib com o responsável fiscal.', refBase);
    if (!r.enquadramentos.length && r.lacuna) { /* o achado da lacuna já explica */ }
    else if (r.enquadramentos.length && !aplic.length && !pendentes.length) add('ok', 'excluidos', `Os enquadramentos do NCM não se aplicam a esta operação: ${lista(r.enquadramentos)}. ${SEM_REGRA} para esta combinação.`, 'Defina CST e cClassTrib com o responsável fiscal.', r.enquadramentos[0].fonte);
  }
  return fechar(base, r);
}

function fechar(base, r) {
  r.achados.sort((a, b) => PESO[a.situacao] - PESO[b.situacao]);
  r.situacao = r.achados.length ? r.achados[0].situacao : 'ok';
  if (!r.achados.length) r.achados.push({situacao: 'ok', codigo: 'sem_achados', motivo: 'Nenhuma divergência nas verificações executadas.', acao: 'Nenhuma ação.', referencia: ''});
  const aplic = r.enquadramentos.filter(e => e.estado === 'aplicavel');
  const ct = r.entrada.cClassTrib;
  r.escolhido = (ct && r.enquadramentos.find(e => e.cClassTrib === ct)) || (aplic.length === 1 && !r.enquadramentos.some(e => e.estado === 'pendente') ? aplic[0] : null);
  return r;
}

// ---------- XML (grupo IBSCBS, NT 2025.002) com campos pendentes marcados ----------
const P = '[PENDENTE]';
export function previaXml(base, r, enquadramento, valores) {
  const pendentes = [];
  const e = enquadramento || r.escolhido;
  const D = base.D;
  const cst = e ? e.cst : null;
  const g = cst && D.cst[cst] ? D.cst[cst].g : {gIBSCBS: 'obrigatorio'};
  const num = (v, d) => (v == null ? null : Number(v).toFixed(d));
  const campo = (tag, v, motivo, ind) => {
    if (v == null) pendentes.push(`${tag}: ${motivo}`);
    return `${ind}<${tag}>${v == null ? P : v}</${tag}>`;
  };
  const linhas = ['<IBSCBS>'];
  linhas.push(campo('CST', cst, 'enquadramento não confirmado', '  '));
  linhas.push(campo('cClassTrib', e ? e.cClassTrib : null, 'enquadramento não confirmado', '  '));
  if (g.gIBSCBS) {
    const v = valores || {};
    linhas.push('  <gIBSCBS>');
    linhas.push(campo('vBC', num(v.vBC, 2), 'valor da operação', '    '));
    const grupo = (tag, pTag, trib, pAliq) => {
      const out = [`    <${tag}>`, campo(pTag, num(pAliq, 4), 'alíquota do ente na data', '      ')];
      if (g.gDif) out.push('      <gDif>', campo('pDif', null, 'percentual de diferimento do regulamento', '        '), campo('vDif', null, 'calculado a partir de pDif', '        '), '      </gDif>');
      let ef = pAliq;
      if (g.gRed) {
        const red = e ? e.red[trib] : null;
        ef = pAliq != null && red != null ? pAliq * (1 - red / 100) : null;
        out.push('      <gRed>', campo('pRedAliq', num(red, 4), 'redução da tabela', '        '), campo('pAliqEfet', num(ef, 4), 'alíquota × (1 − redução)', '        '), '      </gRed>');
      }
      const val = v.vBC != null && ef != null ? Math.round(v.vBC * ef) / 100 : null;
      out.push(campo('v' + pTag.slice(1), num(val, 2), 'base × alíquota efetiva', '      '), `    </${tag}>`);
      return {out, val};
    };
    const uf = grupo('gIBSUF', 'pIBSUF', 'IBSUF', v.pIBSUF);
    const mun = grupo('gIBSMun', 'pIBSMun', 'IBSMun', v.pIBSMun);
    linhas.push(...uf.out, ...mun.out, campo('vIBS', uf.val != null && mun.val != null ? (uf.val + mun.val).toFixed(2) : null, 'soma de vIBSUF e vIBSMun', '    '));
    linhas.push(...grupo('gCBS', 'pCBS', 'CBS', v.pCBS).out);
    linhas.push('  </gIBSCBS>');
  }
  linhas.push('</IBSCBS>');
  return {texto: linhas.join('\n'), pendentes};
}

// ---------- auditoria em lote ----------
export const COLUNAS = [
  ['sku', 'SKU', ['sku', 'codigo', 'cod', 'codigo produto', 'cod produto', 'referencia', 'id']],
  ['descricao', 'Descrição', ['descricao', 'produto', 'nome', 'desc', 'descricao produto']],
  ['ncm', 'NCM', ['ncm', 'ncm sh', 'classificacao fiscal']],
  ['cst', 'CST IBS/CBS', ['cst ibs cbs', 'cst ibscbs', 'cst', 'cst ibs', 'cst cbs']],
  ['cClassTrib', 'cClassTrib', ['cclasstrib', 'classtrib', 'class trib', 'c class trib', 'classificacao tributaria']],
  ['operacao', 'Operação', ['operacao', 'tipo operacao', 'natureza', 'tipo de operacao']],
  ['data', 'Data', ['data', 'data operacao', 'data da operacao', 'dt operacao']],
];

export function sugerirMapeamento(cabecalho) {
  const n = cabecalho.map(h => semAcento(h).replace(/[^a-z0-9]+/g, ' ').trim());
  const mapa = {};
  for (const [campo, , nomes] of COLUNAS) {
    let i = n.findIndex(h => nomes.includes(h));
    if (i < 0) i = n.findIndex(h => nomes.some(x => x.length > 3 && h.includes(x)));
    mapa[campo] = i >= 0 && !Object.values(mapa).includes(i) ? i : -1;
  }
  return mapa;
}

export function analisarLinha(base, campos, mapa, padrao) {
  const v = k => (mapa[k] >= 0 ? (campos[mapa[k]] ?? '') : '');
  const opLinha = texto(v('operacao')), dataLinha = texto(v('data'));
  return analisar(base, {
    ncm: v('ncm'), cst: v('cst'), cClassTrib: v('cClassTrib'),
    operacao: opLinha || padrao.operacao, data: dataLinha || padrao.data, respostas: padrao.respostas || {},
  });
}

export function linhaExportacao(registro, mapa, r) {
  const v = k => (mapa[k] >= 0 ? (registro.campos[mapa[k]] ?? '') : '');
  const principal = r.achados[0];
  const todos = r.achados.filter(a => a.situacao === r.situacao);
  return {
    'Linha no arquivo': String(registro.linha), SKU: v('sku'), 'Descrição': v('descricao'), 'NCM recebido': v('ncm'),
    'CST recebido': v('cst'), 'cClassTrib recebido': v('cClassTrib'), 'Operação': r.entrada.operacao ? (r.entrada.operacao) : r.entrada.operacaoRecebida,
    'Data': r.entrada.data ? fmtData(r.entrada.data) : r.entrada.dataRecebida, 'Situação': SITUACOES[r.situacao],
    'Motivo': todos.map(a => a.motivo).join(' | '), 'Ação sugerida': todos.map(a => a.acao).join(' | '),
    'Referência utilizada': [...new Set(todos.map(a => a.referencia).filter(Boolean))].join(' | ') || principal.referencia,
  };
}

// ---------- tabela cClassTrib (consulta e planilha) ----------
export function tabelaClassTrib(base, data) {
  const D = base.D;
  return Object.entries(D.ct).sort(([a], [b]) => a.localeCompare(b)).map(([codigo, t]) => {
    const red = reducoes(t, data);
    const g = D.cst[t.cst] ? Object.keys(D.cst[t.cst].g).join(', ') : '';
    return {
      'cClassTrib': codigo, 'CST': t.cst, 'Descrição do CST': D.cst[t.cst]?.nome || '', 'Nome': t.nome, 'Descrição': t.desc,
      'Redução CBS (%)': red.CBS ?? '', 'Redução IBS UF (%)': red.IBSUF ?? '', 'Redução IBS Mun (%)': red.IBSMun ?? '',
      'Anexo LC 214': t.anexo || '', 'Base legal': t.art ? `LC 214/2025, ${t.art}` : '', 'Link': t.url || '',
      'Início da vigência': fmtData(t.ini), 'Fim da vigência': fmtData(t.fim), 'Publicação na tabela': fmtData(t.pub),
      'Usado em NF-e': t.nfe === true ? 'Sim' : t.nfe === false ? 'Não' : '', 'Grupos do XML exigidos': g,
      'Vigente na data': vigente(t.ini, t.fim, data) ? 'Sim' : 'Não',
    };
  });
}
