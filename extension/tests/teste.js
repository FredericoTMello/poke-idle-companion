// Testa captura.js num ambiente de navegador simulado, com mensagens sintéticas.
// Rode: node teste.js

const fs = require('fs');
const vm = require('vm');

// ---- navegador de mentira ----
const guardado = {};
class WSFalso {
  constructor(url) { this.url = url; this.ouvintes = []; }
  addEventListener(_, fn) { this.ouvintes.push(fn); }
  receber(obj) { const ev = { data: JSON.stringify(obj) }; this.ouvintes.forEach(f => f(ev)); }
}
// Elemento de mentira recursivo: querySelector devolve outro elemento completo,
// senão o painel quebra ao mexer em style/textContent do que achou.
const elFalso = () => ({
  style: {}, innerHTML: '', id: '', innerText: '', textContent: '', title: '',
  appendChild() {}, addEventListener() {}, setPointerCapture() {}, click() {},
  querySelector() { return elFalso(); },
  getBoundingClientRect() { return { left: 0, top: 0, width: 264, height: 200 }; },
});
const janela = {
  WebSocket: WSFalso,
  localStorage: {
    getItem: k => (k in guardado ? guardado[k] : null),
    setItem: (k, v) => { guardado[k] = v; },
  },
  addEventListener() {},
  setInterval() { return 0; },
  innerWidth: 1280, innerHeight: 800,
  URL: { createObjectURL: () => '', revokeObjectURL() {} },
  Blob: class {},
  confirm: () => false,
};
janela.window = janela;
const doc = {
  body: elFalso(),
  getElementById: () => null,
  createElement: elFalso,
  addEventListener() {},
  // nós visíveis para a leitura da barra de EXP; os testes trocam à vontade
  nos: [],
  querySelectorAll() { return doc.nos; },
};
// barra de EXP como o jogo monta: texto "EXP 79%" com a largura em 4 casas
const barraExp = pct => [{
  textContent: 'EXP ' + Math.round(pct) + '%',
  getAttribute: () => null,
  querySelectorAll: () => [{ style: { width: pct.toFixed(4) + '%' } }],
}];
// card do pokémon ativo: title "(ativo)". O HP cheio (1620/1620) vem ANTES do XP
// de propósito — é o número que era pego por engano e dava falta zero.
const cardAtivo = (atual, prox) => [{
  getAttribute: k => (k === 'title' ? 'Exeggcute (ativo)' : null),
  textContent: 'Exeggcute Lv.92 1620/1620 HP ' + atual + '/' + prox + ' EXP 27%',
  querySelectorAll: () => [],
}];
const ctx = vm.createContext(Object.assign(janela, {
  document: doc, console, Date, Math, JSON, Object, Array, isFinite, setInterval: () => 0,
}));

vm.runInContext(fs.readFileSync(__dirname + '/../dados-combate.js', 'utf8'), ctx);
// o content script roda no escopo global da página: expõe o que dados-combate.js
// pendurou em window para o captura.js enxergar como identificador solto
ctx.CRIATURAS = ctx.window.CRIATURAS;
ctx.TIPOS = ctx.window.TIPOS;
vm.runInContext(fs.readFileSync(__dirname + '/../captura.js', 'utf8'), ctx);
const ws = new ctx.WebSocket('wss://exemplo/ws');

// ---- cenário sintético ----
const stats = { hp: 12, atk: 13, def: 11, spAtk: 8, spDef: 11, speed: 7 };
ws.receber({ type: 'pokes', list: [
  { id: 'a1', name: 'Machoke', speciesId: 67, level: 7, stats, quality: 1.579, ivTotal: 101, power: 98, maxHp: 144, team: true, leader: true },
  { id: 'a2', name: 'Charmander', speciesId: 4, level: 25, stats: { hp: 10, atk: 23, def: 23, spAtk: 25, spDef: 17, speed: 18 }, quality: .816, ivTotal: 121, power: 95, maxHp: 120 },
]});
ws.receber({ type: 'field-init', slug: 'rattata' });

// 3 rodadas de campo: mob vivo, golpes, mob morre
const mob = (dead) => ({ slot: 3, speciesId: 19, hp: dead ? 0 : 120, maxHp: 120, dead, shiny: false });
ws.receber({ type: 'field', heroMaxHp: 144, heroHp: 144, mobs: [mob(false)], hits: [] });
for (const dano of [180, 195, 205, 188]) {
  ws.receber({ type: 'field', heroMaxHp: 144, mobs: [mob(false)],
               hits: [{ slot: 3, amount: dano, eff: 2.5, move: 'Karate Chop', type: 'FIGHTING' }] });
}
// dano recebido (slot -1)
ws.receber({ type: 'field', heroMaxHp: 144, mobs: [mob(false)],
             hits: [{ slot: -1, amount: 31, eff: 1, move: 'Quick Attack' }] });
ws.receber({ type: 'field-kill', speciesName: 'Rattata', xpGained: 12, xpParts: { base: 8, vip: 4 } });
ws.receber({ type: 'catch-result', speciesName: 'Rattata', ballName: 'Poké Ball', ballId: 1, success: false });
ws.receber({ type: 'catch-result', speciesName: 'Rattata', ballName: 'Poké Ball', ballId: 1, success: true });
// mob morre e renasce -> respawn
ws.receber({ type: 'field', heroMaxHp: 144, mobs: [mob(true)], hits: [] });
ws.receber({ type: 'field', heroMaxHp: 144, mobs: [mob(false)], hits: [] });
// um shiny aparece
ws.receber({ type: 'field', heroMaxHp: 144,
             mobs: [{ slot: 9, speciesId: 10501, hp: 2000, maxHp: 2000, dead: false, shiny: true }], hits: [] });
// lixo que não pode quebrar nada
ws.receber({ type: 'chat', body: 'oi' });
[null, undefined, 'nao-e-json', '{quebrado'].forEach(x => { try { ws.ouvintes[0]({ data: x }); } catch (e) { console.log('QUEBROU com', x, e.message); } });

// ---- conferência ----
const D = ctx.__piwColetor.dados();
const ok = [];
const falha = [];
const t = (nome, cond, obs) => (cond ? ok : falha).push(nome + (obs ? ' -> ' + obs : ''));

const chaves = Object.keys(D.baldes);
t('criou 1 balde de golpe', chaves.length === 1, chaves.length + ' baldes');
const b = D.baldes[chaves[0]];
t('agregou os 4 golpes', b && b.n === 4, b && b.n);
t('media correta (192)', b && Math.round(b.soma / b.n) === 192, b && (b.soma / b.n).toFixed(1));
t('min/max corretos', b && b.min === 180 && b.max === 205, b && b.min + '-' + b.max);
t('chave carrega atacante+nivel+atk', /Machoke\|7\|13\|/.test(chaves[0]), chaves[0]);
t('chave carrega golpe+eff+alvo+hp', /Karate Chop\|2\.5\|19\|120/.test(chaves[0]));
t('identificou o ativo pelo maxHp', /^Machoke/.test(chaves[0]));
t('dano recebido separado', Object.keys(D.danoRecebido).length === 1);
t('dano recebido guarda a hunt de origem', /\|rattata$/.test(Object.keys(D.danoRecebido)[0]),
  Object.keys(D.danoRecebido)[0]);
// Sem carimbo de tempo no dano recebido não dá para medir a cadência do inimigo,
// e o filtro de letalidade fica preso numa suposição impossível de conferir.
t('dano recebido tem carimbo de tempo', D.cruasRecebidas.length === 1 && D.cruasRecebidas[0].t > 0,
  D.cruasRecebidas.length + ' amostra(s)');
t('janela de recebidos nao rouba a de dados', D.cruas.every(x => x.dano !== 31 || x.alvo));
t('kill contabilizado', D.kills.Rattata && D.kills.Rattata.n === 1);
t('xpParts guardado', D.kills.Rattata && D.kills.Rattata.partes && D.kills.Rattata.partes.vip === 4);
t('capturas 1/2', D.capturas['Poké Ball|Rattata'] && D.capturas['Poké Ball|Rattata'].tent === 2 && D.capturas['Poké Ball|Rattata'].ok === 1);
t('respawn medido', D.respawns.n === 1, D.respawns.n + ' evento(s)');
t('shiny registrado', D.shinies.length === 1);
t('spawns por especie', D.spawns['19'] && D.spawns['19'].n >= 1);
t('guardou meus pokemon', Object.keys(D.meusPokemon).length === 2);
t('amostras cruas com stats', D.cruas.length === 4 && D.cruas[0].stats && D.cruas[0].stats.atk === 13);

// ---- otimizador: roda sem digitação, lendo time e alvo do socket ----
const r = ctx.__piwColetor.ranking ? ctx.__piwColetor.ranking() : null;
t('otimizador disponivel', !!ctx.__piwColetor.ranking);
t('detectou o alvo em campo', r && r.alvo, r && r.alvo ? r.alvo.nome : 'nenhum');
t('usou o HP observado, nao a estimativa', r && r.alvo && r.alvo.hpMedido && r.alvo.hp === 120, r && r.alvo ? r.alvo.hp : '?');
t('montou ranking do time', r && r.itens.length >= 1, r ? r.itens.length + ' item(ns)' : '0');
if (r && r.itens.length) {
  const it = r.itens[0];
  t('escolheu um golpe', !!it.golpe, it.golpe && it.golpe.n);
  t('calculou dano > 0', it.dano > 0, it.dano && it.dano.toFixed(1));
  t('calculou tempo finito', isFinite(it.seg), it.seg && it.seg.toFixed(1) + 's');
  t('ordenou do mais rapido', r.itens.every((x, i) => i === 0 || r.itens[i - 1].seg <= x.seg));
  t('marcou o pokemon ativo', r.itens.some(x => x.ativo));
}
// alvo desconhecido não pode derrubar
try { ctx.__piwColetor.ranking(); t('ranking nao lanca excecao', true); }
catch (e) { t('ranking nao lanca excecao', false, e.message); }

// ---- medição vence previsão ----
// O balde do Machoke tem 4 golpes (abaixo do mínimo de 8) -> deve cair na estimativa.
const machoke = r && r.itens.find(x => x.nome === 'Machoke');
t('amostra pequena cai na estimativa', machoke && machoke.fonte === 'estimado', machoke && machoke.fonte);

// agora enche o mesmo balde acima do mínimo e confere a virada
for (let i = 0; i < 10; i++)
  ws.receber({ type: 'field', heroMaxHp: 144, mobs: [mob(false)],
               hits: [{ slot: 3, amount: 200, eff: 2.5, move: 'Karate Chop', type: 'FIGHTING' }] });
const r2 = ctx.__piwColetor.ranking();
const m2 = r2 && r2.itens.find(x => x.nome === 'Machoke');
t('com amostra suficiente, usa o medido', m2 && m2.fonte.indexOf('medido') === 0, m2 && m2.fonte);
// média real do balde: (180+195+205+188) + 10×200 = 2768 em 14 golpes = 197,71
t('usa o dano REAL medido, nao o previsto', m2 && Math.abs(m2.dano - 197.71) < 0.5, m2 && m2.dano.toFixed(2));
t('usa o golpe que o jogo REALMENTE escolheu', m2 && m2.golpe.n === 'Karate Chop', m2 && m2.golpe.n);
t('recalcula os golpes com o dano medido', m2 && m2.golpes === 1, m2 && m2.golpes);

// ---- tempo medido vence tempo calculado ----
// Sem ritmo registrado ainda, deve cair no calculado (marcado com tempoMedido false).
const r3 = ctx.__piwColetor.ranking();
const m3 = r3 && r3.itens.find(x => x.nome === 'Machoke');
t('sem ritmo, usa tempo calculado', m3 && m3.tempoMedido === false, m3 && String(m3.tempoMedido));
t('media ponderada de TODOS os golpes', m3 && m3.fonte.indexOf('medido') === 0, m3 && m3.fonte);

// agora simula 6 abates espaçados 15s para criar ritmo real
const D0 = ctx.__piwColetor.dados();
D0.kills['Rattata'].ritmo = { 'Machoke|7': { n: 6, soma: 75, gaps: 5, pausas: 0, ultimo: Date.now() } };
const r4 = ctx.__piwColetor.ranking();
const m4 = r4 && r4.itens.find(x => x.nome === 'Machoke');
t('com ritmo registrado, usa o MEDIDO', m4 && m4.tempoMedido === true, m4 && String(m4.tempoMedido));
t('tempo medido = 15s por abate', m4 && Math.abs(m4.seg - 15) < 0.5, m4 && m4.seg.toFixed(1) + 's');

// Registro no formato ANTIGO (só primeiro/ultimo) não pode virar NaN no painel:
// tem que ser ignorado e cair no tempo calculado.
D0.kills['Rattata'].ritmo = { 'Machoke|7': { n: 40, primeiro: Date.now() - 9e6, ultimo: Date.now() } };
const r5 = ctx.__piwColetor.ranking();
const m5 = r5 && r5.itens.find(x => x.nome === 'Machoke');
t('registro antigo é ignorado, nao vira NaN', m5 && m5.tempoMedido === false && isFinite(m5.seg),
  m5 && m5.tempoMedido + '/' + m5.seg);

// Pausa longa não pode entrar na conta: 5 intervalos de 9s + uma ausência de 2h
// tem que continuar dando 9s por abate, não 1440s.
D0.kills['Rattata'].ritmo = { 'Machoke|7': { n: 7, soma: 45, gaps: 5, pausas: 1, ultimo: Date.now() } };
const r6 = ctx.__piwColetor.ranking();
const m6 = r6 && r6.itens.find(x => x.nome === 'Machoke');
t('pausa longa nao contamina o ritmo', m6 && Math.abs(m6.seg - 9) < 0.5, m6 && m6.seg.toFixed(1) + 's');

// Os testes acima injetam o ritmo pronto e só conferem a LEITURA. O corte de
// pausa mora no handler de field-kill, então aqui dirigimos abates de verdade
// com relógio controlado — é a única forma de exercitar a acumulação.
const DateReal = ctx.Date;
let relogio = DateReal.now();
ctx.Date = { now: () => relogio };
const abate = () => ws.receber({ type: 'field-kill', speciesName: 'Pidgey', xpGained: 5 });
const ritPidgey = () => ctx.__piwColetor.dados().kills['Pidgey'].ritmo['Machoke|7'];

abate();
for (let i = 0; i < 4; i++) { relogio += 9000; abate(); }
const rp = ritPidgey();
t('acumula intervalo entre abates', rp && rp.gaps === 4 && Math.abs(rp.soma - 36) < 0.01,
  rp && rp.gaps + ' gaps, soma ' + rp.soma);

relogio += 2 * 3600 * 1000;   // duas horas ausente
abate();
const rp2 = ritPidgey();
t('ausencia de 2h conta como pausa, nao como abate lento',
  rp2 && rp2.pausas === 1 && rp2.gaps === 4 && Math.abs(rp2.soma - 36) < 0.01,
  rp2 && rp2.gaps + ' gaps / ' + rp2.pausas + ' pausas / soma ' + rp2.soma);

relogio += 9000; abate();     // volta a caçar: retoma a contagem normalmente
const rp3 = ritPidgey();
t('volta a contar depois da pausa', rp3 && rp3.gaps === 5 && Math.abs(rp3.soma - 45) < 0.01,
  rp3 && rp3.gaps + ' gaps, soma ' + rp3.soma);
ctx.Date = DateReal;

// ---- espera de respawn e overkill ----
// O Rattata ficou com ritmo de 9s/abate (soma 45 / 5 gaps) e dano medido que o
// derruba em 1 golpe: 9s − 1,6s de combate = 7,4s parado esperando renascer.
D0.kills['Rattata'].ritmo = { 'Machoke|7': { n: 6, soma: 45, gaps: 5, pausas: 0, ultimo: Date.now() } };
const cs = ctx.__piwColetor.melhoresCacas(400);   // lista toda: aqui testamos a mecânica, não o ranking
const rat = cs && cs.find(x => x.nome === 'Rattata');
t('espera de respawn sai por subtracao', rat && rat.esperaMedida === true && Math.abs(rat.espera - 7.4) < 0.1,
  rat && rat.espera.toFixed(1) + 's');
t('1 golpe com espera maior que combate = overkill', rat && rat.overkill === true && rat.golpes === 1,
  rat && rat.golpes + ' golpe / overkill ' + rat.overkill);
t('tempo total = combate + espera', rat && Math.abs(rat.seg - (rat.combate + rat.espera)) < 0.01,
  rat && rat.combate.toFixed(1) + '+' + rat.espera.toFixed(1) + '=' + rat.seg.toFixed(1) + 's');
// Alvo que exige vários golpes não pode ser marcado como overkill.
const gordo = cs && cs.find(x => x.golpes > 3);
t('alvo que exige varios golpes nao e overkill', gordo && gordo.overkill === false,
  gordo && gordo.nome + ' ' + gordo.golpes + ' golpes');

// ---- a lista precisa estar na MESMA régua do número medido ----
// O xp/s da lista sai do modelo; o do topo do painel sai da medição. Sem
// calibrar, o painel anunciava "RENDE MAIS" sobre alvos que rendiam MENOS
// (501 medido contra 371 modelado, e o modelo nem contava o VIP).
const csCal = ctx.__piwColetor.melhoresCacas(400);
const dCal = ctx.__piwColetor.dados();
// A âncora é o alvo com MAIS abates medidos — mais dado, fator melhor.
let ancora = null;
for (const nome in dCal.kills) {
  const linha = csCal.find(x => x.nome === nome);
  const rit = dCal.kills[nome].ritmo && dCal.kills[nome].ritmo['Machoke|7'];
  if (!linha || !rit || !(rit.gaps >= 5)) continue;
  if (!ancora || dCal.kills[nome].n > ancora.n) ancora = { nome, n: dCal.kills[nome].n, linha, rit };
}
const xpsMedido = ancora && (dCal.kills[ancora.nome].xpTotal / ancora.n) / (ancora.rit.soma / ancora.rit.gaps);
t('lista calibrada pelo alvo mais medido', ancora && Math.abs(ancora.linha.xps - xpsMedido) < 0.001,
  ancora && ancora.nome + ': ' + ancora.linha.xps.toFixed(3) + ' vs ' + xpsMedido.toFixed(3) + ' medido');
t('marca que a lista foi calibrada', ancora && ancora.linha.calibrado === true,
  ancora && String(ancora.linha.calibrado));
// A ordem não pode mudar com a calibração: é um fator comum a todos.
const ordemOk = csCal.every((x, i) => i === 0 || x.letal || csCal[i - 1].letal || csCal[i - 1].xps >= x.xps);
t('calibracao nao bagunca a ordem', ordemOk);

// ---- quanto falta para o próximo nível ----
// O jogo só mostra "EXP 79%", mas a largura da barra tem 4 casas. Medimos a
// velocidade do próprio progresso — não precisamos da curva de XP do jogo.
doc.nos = [];
t('sem barra de EXP na tela, nao inventa', ctx.__piwColetor.faltaNivel() === null);

const relogioProg = DateReal.now();
ctx.Date = { now: () => relogioProg };
doc.nos = barraExp(78.9299);
const p1 = ctx.__piwColetor.faltaNivel();
t('le a barra com as 4 casas', p1 && Math.abs(p1.pct - 78.9299) < 0.0001, p1 && p1.pct);
t('calcula o quanto falta', p1 && Math.abs(p1.falta - 21.0701) < 0.0001, p1 && p1.falta.toFixed(4) + '%');
t('sem janela nao chuta tempo', p1 && p1.seg === null);

// 10 min depois subiu 5 pontos: sobram 16,07 pontos a 5 pontos por 600 s = ~32 min
ctx.Date = { now: () => relogioProg + 600000 };
doc.nos = barraExp(83.9299);
const p2 = ctx.__piwColetor.faltaNivel();
t('estima o tempo pelo ritmo medido', p2 && Math.abs(p2.seg - 1928.4) < 5,
  p2 && p2.seg && (p2.seg / 60).toFixed(1) + ' min');

// caminho preferido: XP absoluto do card do ativo ÷ XP/s medido = tempo EXATO.
// Foi o que consertou o "1h23 errado" — antes eu extrapolava a velocidade da
// barra (frágil, e às vezes a barra de outro pokémon).
doc.nos = cardAtivo(961, 1884);        // faltam 923 XP
const pAbs = ctx.__piwColetor.faltaNivel(100);   // 100 XP/s medido -> 9,23 s
t('usa o XP absoluto do card do ativo', pAbs && pAbs.exato === true, pAbs && 'exato=' + pAbs.exato);
// se pegasse o HP cheio (1620/1620), pct seria 100% e o tempo 0. Pegando o XP
// (961/1884), pct ~51% e tempo 9,23s. É o teste que reproduz o bug do "0,2s".
t('pega o XP, nao o HP cheio que vem antes', pAbs && pAbs.seg > 1 && Math.abs(pAbs.pct - 51.0085) < 0.01,
  pAbs && 'pct ' + pAbs.pct.toFixed(1) + '% seg ' + pAbs.seg.toFixed(2));
t('tempo = XP que falta / XP por segundo', pAbs && Math.abs(pAbs.seg - 9.23) < 0.001,
  pAbs && pAbs.seg.toFixed(2) + 's');
t('pct vem do XP absoluto', pAbs && Math.abs(pAbs.pct - 100 * 961 / 1884) < 0.001, pAbs && pAbs.pct.toFixed(1) + '%');
t('sem XP/s medido nao chuta tempo', ctx.__piwColetor.faltaNivel(0).seg === null);

// subiu de nível: a porcentagem despenca e a medição recomeça do zero
ctx.Date = { now: () => relogioProg + 660000 };
doc.nos = barraExp(2.5);
const p3 = ctx.__piwColetor.faltaNivel();
t('level up reinicia a medicao', p3 && p3.seg === null && Math.abs(p3.pct - 2.5) < 0.001,
  p3 && p3.pct + '% / seg ' + p3.seg);
ctx.Date = DateReal;
doc.nos = [];

// ---- desfecho do shiny ----
// O shiny tem o MESMO id de espécie do bicho normal, então a captura dele não dá
// para separar pela mensagem. O jogo derruba o shiny e SÓ ENTÃO pede a bola, e é
// essa ordem que permite ligar a tentativa ao shiny certo.
t('shiny ainda sem desfecho', D.shinies[0] && !D.shinies[0].desfecho);
ws.receber({ type: 'field', heroMaxHp: 144,
             mobs: [{ slot: 9, speciesId: 10501, hp: 0, maxHp: 2000, dead: true, shiny: true }], hits: [] });
ws.receber({ type: 'catch-result', speciesName: 'Oddish', ballName: 'Ultra Ball', ballId: 4, success: true });
t('captura logo apos a queda vira desfecho do shiny',
  D.shinies[0] && D.shinies[0].desfecho === 'capturado', D.shinies[0] && D.shinies[0].desfecho);
t('guarda a bola usada no shiny', D.shinies[0] && D.shinies[0].bola === 'Ultra Ball', D.shinies[0] && D.shinies[0].bola);
// captura comum depois disso não pode reescrever o desfecho já fechado
ws.receber({ type: 'catch-result', speciesName: 'Rattata', ballName: 'Poké Ball', ballId: 1, success: false });
t('captura comum nao mexe no shiny fechado', D.shinies[0] && D.shinies[0].desfecho === 'capturado');
t('resumo conta os shinies', /✨ 1 shiny visto \(1 capturado\)/.test(ctx.__piwColetor.resumo()),
  (ctx.__piwColetor.resumo().split('\n').find(l => /✨.*shiny/.test(l)) || 'sem linha'));

// ---- resumo para colar no chat ----
const resumo = ctx.__piwColetor.resumo ? ctx.__piwColetor.resumo() : null;
t('resumo disponivel', !!resumo);
t('resumo traz abates e XP', resumo && /abates/.test(resumo) && /XP/.test(resumo));
t('resumo nao vaza NaN nem Infinity', resumo && !/NaN|Infinity|undefined/.test(resumo),
  resumo && resumo.split('\n')[0]);

// REGRESSÃO: subir de nível não pode apagar a espera medida. A espera é do mapa,
// não do pokémon — amarrá-la ao ritmo do nível ATIVO zerava tudo a cada level up,
// e o jogador sobe de nível a cada poucos minutos.
ws.receber({ type: 'pokes', list: [
  { id: 'a1', name: 'Machoke', speciesId: 67, level: 8, stats, quality: 1.579, ivTotal: 101, power: 98, maxHp: 144, team: true, leader: true },
]});
ws.receber({ type: 'field', heroMaxHp: 144, heroHp: 144, mobs: [mob(false)], hits: [] });
const csNv8 = ctx.__piwColetor.melhoresCacas(400);
const ratNv8 = csNv8 && csNv8.find(x => x.nome === 'Rattata');
t('espera sobrevive ao level up', ratNv8 && ratNv8.esperaMedida === true && Math.abs(ratNv8.espera - 7.4) < 0.1,
  ratNv8 && ratNv8.esperaMedida + ' / ' + ratNv8.espera.toFixed(1) + 's');

// ---- a fórmula de dano é a validada, não a antiga ----
// Machoke nv16 (atk 30) com Arm Thrust contra Magnemite deu 177,9 de dano medido
// em 118 golpes. O modelo validado erra 1,5%; o antigo errava mais de 3×.
const magnemite = ctx.CRIATURAS.find(c => c.nome === 'Magnemite' && c.cacavel);
const prevAT = 0.007416 * 30 * 30 * 120 * 2.5 / magnemite.def;
t('formula fisica bate com o medido (Arm Thrust)', Math.abs(prevAT - 177.9) / 177.9 < 0.05,
  prevAT.toFixed(1) + ' vs 177,9 medido');
// Especial usa a MEDIA GEOMETRICA: atk × spAtk, não spAtk². Exeggcute nv73
// (atk 115, spAtk 108) com Leech Seed no Onix deu 1300,9 em 83 golpes.
const onix = ctx.CRIATURAS.find(c => c.nome === 'Onix' && c.cacavel);
const prevLS = 0.007416 * 115 * 108 * 120 * 5.5 / onix.spDef;
t('formula especial usa media geometrica', Math.abs(prevLS - 1300.9) / 1300.9 < 0.10,
  prevLS.toFixed(0) + ' vs 1301 medido');
const seFosseSpAtk = 0.007416 * 108 * 108 * 120 * 5.5 / onix.spDef;
t('spAtk puro seria pior que a geometrica',
  Math.abs(prevLS - 1300.9) < Math.abs(seFosseSpAtk - 1300.9),
  'geometrica ' + prevLS.toFixed(0) + ' vs spAtk² ' + seFosseSpAtk.toFixed(0));

// ---- a hunt é trancada pelo nível do PERSONAGEM ----
// Sem saber o nível do personagem não dá para filtrar — e esconder alvo bom é
// pior que sugerir mapa trancado, então nesse caso não filtramos.
doc.body.innerText = '';
const semNivel = ctx.__piwColetor.melhoresCacas(400);
t('sem nivel do personagem, nao filtra', semNivel.some(x => x.nivel > 8),
  'maior nivel oferecido: ' + Math.max(...semNivel.map(x => x.nivel)));

// Com o personagem no nível 30, hunts acima disso somem — mesmo que o POKÉMON
// esteja no nível 8. Quem destrava a hunt é o personagem.
doc.body.innerText = 'AllMight Nível 30 · Rattata';
ctx.Date = { now: () => DateReal.now() + 60000 };   // fura o cache de 30 s
const comNivel = ctx.__piwColetor.melhoresCacas(400);
ctx.Date = DateReal;
t('filtra pelo nivel do PERSONAGEM, nao do pokemon', comNivel.every(x => x.nivel <= 30),
  'maior nivel oferecido: ' + Math.max(...comNivel.map(x => x.nivel)));
t('e o personagem destrava alvo acima do pokemon', comNivel.some(x => x.nivel > 8),
  'pokemon nv8 recebe alvo nv' + Math.max(...comNivel.map(x => x.nivel)));

// ---- alvo que mata o jogador não pode ser recomendado ----
// Precisa de nível alto para as hunts perigosas destravarem, com atributos fracos
// para a luta ficar longa — é assim que se chega a um alvo letal legítimo.
ws.receber({ type: 'pokes', list: [
  { id: 'a1', name: 'Machoke', speciesId: 67, level: 100, stats, quality: 1.579, ivTotal: 101, power: 98, maxHp: 144, team: true, leader: true },
]});
ws.receber({ type: 'field', heroMaxHp: 144, heroHp: 144, mobs: [mob(false)], hits: [] });
// Sem dano recebido suficiente não dá para julgar: ninguém é marcado letal.
const semJulgar = ctx.__piwColetor.melhoresCacas(400);
t('sem dano recebido medido, ninguem e letal', semJulgar.every(x => x.letal === false),
  semJulgar.filter(x => x.letal).length + ' letais');

// 25 golpes de 31 no herói: 31/1,6 = 19,4 dano/s contra 144 de HP -> ele aguenta 7,4s.
for (let i = 0; i < 25; i++)
  ws.receber({ type: 'field', heroMaxHp: 144, mobs: [mob(false)],
               hits: [{ slot: -1, amount: 31, eff: 1, move: 'Quick Attack' }] });
const julgado = ctx.__piwColetor.melhoresCacas(400);
const rat2 = julgado.find(x => x.nome === 'Rattata');
const longo = julgado.find(x => x.combate > 7.4);
t('luta curta nao e letal', rat2 && rat2.letal === false, rat2 && rat2.combate.toFixed(1) + 's de luta');
t('luta mais longa que a sobrevivencia e letal', longo && longo.letal === true,
  longo && longo.nome + ' ' + longo.combate.toFixed(1) + 's');
// O que mata vai para o fim mesmo tendo xp/s alto — é o erro que mandava um
// Machoke nv20 encarar um Tyranitar nv100.
const primeiroLetal = julgado.findIndex(x => x.letal);
const ultimoVivo = julgado.map(x => !x.letal).lastIndexOf(true);
t('letal fica abaixo de todo nao-letal', primeiroLetal === -1 || primeiroLetal > ultimoVivo,
  'letal em ' + primeiroLetal + ', ultimo vivo em ' + ultimoVivo);
t('existe letal com xp/s maior que o topo vivo',
  julgado.some(x => x.letal && x.xps > julgado[0].xps),
  'topo vivo ' + julgado[0].nome + ' ' + julgado[0].xps.toFixed(1) + ' xp/s');

// ---- recomendação de caça para o pokémon ativo ----
const cacas = ctx.__piwColetor.melhoresCacas ? ctx.__piwColetor.melhoresCacas(5) : null;
t('recomendacao de caca disponivel', !!cacas, cacas ? cacas.length + ' alvos' : 'ausente');
if (cacas && cacas.length) {
  t('so recomenda o que existe no jogo',
    cacas.every(c => { const alvo = ctx.window.CRIATURAS.find(x => x.nome === c.nome); return alvo && alvo.cacavel; }),
    cacas.map(c => c.nome).join(', '));
  t('nunca recomenda Sentret (nao existe)', !cacas.some(c => c.nome === 'Sentret'));
  t('ordena por xp por segundo', cacas.every((c, i) => i === 0 || cacas[i - 1].xps >= c.xps));
  t('todos com efetividade > 0', cacas.every(c => c.ef > 0));
  t('todos com xp conhecido', cacas.every(c => c.xp > 0));
}

// persistência
ctx.__piwColetor.salvar();
t('persistiu no localStorage', !!guardado.piw_coletor_v1);
let recarregado = null;
try { recarregado = JSON.parse(guardado.piw_coletor_v1); } catch (e) {}
t('o que foi salvo relê como JSON', !!recarregado);
t('dados sobrevivem ao reload', recarregado && Object.keys(recarregado.baldes).length === 1);
const tamanho = (guardado.piw_coletor_v1 || '').length;

console.log('\n=== PASSOU (' + ok.length + ') ===');
ok.forEach(x => console.log('  ok  ' + x));
if (falha.length) { console.log('\n=== FALHOU (' + falha.length + ') ==='); falha.forEach(x => console.log('  XX  ' + x)); }
console.log('\ntamanho salvo neste cenário: ' + tamanho + ' bytes');
console.log('projeção para um dia inteiro: os golpes viram baldes, não crescem com o volume.');
console.log('o que cresce é o número de CONDIÇÕES distintas (atacante×nível×golpe×alvo), com teto de 8000.');
console.log('\n' + (falha.length ? 'HÁ FALHAS — não usar assim' : 'TUDO CERTO — pode rodar sem supervisão'));
