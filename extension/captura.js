// PIW — Coletor de Dados
//
// SOMENTE LEITURA. Não envia nada ao servidor, não clica, não age no jogo.
// O método `send` do WebSocket não é tocado — só escutamos as mensagens que o
// servidor já manda para o navegador.
//
// Precisa rodar em "world": "MAIN" e "run_at": "document_start": o WebSocket do
// jogo é criado durante o carregamento, e um hook instalado depois não pegaria
// a conexão existente.

(function () {
  'use strict';
  if (window.__piwColetor) return;

  const CHAVE = 'piw_coletor_v1';
  const SALVAR_A_CADA_MS = 15000;
  const MAX_BALDES = 8000;      // teto de combinações distintas guardadas
  const MAX_AMOSTRAS_CRUAS = 500;
  // Intervalo entre abates acima disto não é ritmo de caça — é o jogador ausente,
  // troca de mapa ou aba dormindo. Um abate ruim de verdade leva dezenas de
  // segundos, nunca minutos, então 120 s separa os dois casos com folga.
  const MAX_GAP_ABATE_S = 120;

  // ---- estado persistido ----
  // Agregamos em baldes em vez de guardar cada golpe: um dia inteiro de caça
  // são centenas de milhares de eventos, e para ajustar a fórmula só precisamos
  // de contagem, soma, mínimo, máximo e soma dos quadrados por combinação.
  const vazio = () => ({
    versao: 1,
    inicio: Date.now(),
    baldes: {},        // chave -> {n, soma, sq, min, max}
    spawns: {},        // especie -> {n, soma, min, max, valores:{hp:contagem}}
    capturas: {},      // "bola|especie" -> {tent, ok}
    kills: {},         // especie -> {n, xpTotal, partes}
    respawns: { n: 0, soma: 0, min: null, max: null },
    shinies: [],
    danoRecebido: {},  // "golpe|eff|hunt" -> {n, soma, min, max}
    meusPokemon: {},   // id -> ultimo estado (nivel, stats, qualidade, iv)
    cruas: [],         // janela deslizante de golpes DADOS, com carimbo de tempo
    cruasRecebidas: [], // idem para golpes RECEBIDOS: mede a cadência do inimigo
    minutosAtivos: 0,
  });

  let D;
  try {
    const salvo = localStorage.getItem(CHAVE);
    D = salvo ? JSON.parse(salvo) : vazio();
    if (D.versao !== 1) D = vazio();
    // Base gravada por versão anterior não tem esta janela. Sem isto o push
    // lança, e o catch do registrador engoliria TODA a coleta em silêncio.
    if (!Array.isArray(D.cruasRecebidas)) D.cruasRecebidas = [];
  } catch (e) { D = vazio(); }

  // ---- estado volátil ----
  const mobs = {};
  const mortoEm = {};
  let ativo = null;
  let hunt = null;
  let sujo = false;
  let shinyCaido = null;   // shiny derrubado esperando a bola
  let avistadoShiny = null; // shiny na tela agora (para o alerta do painel)

  const num = v => typeof v === 'number' && isFinite(v);

  function acumula(obj, chave, valor) {
    let b = obj[chave];
    if (!b) {
      if (Object.keys(obj).length >= MAX_BALDES) return;
      b = obj[chave] = { n: 0, soma: 0, sq: 0, min: valor, max: valor };
    }
    b.n++; b.soma += valor; b.sq += valor * valor;
    if (valor < b.min) b.min = valor;
    if (valor > b.max) b.max = valor;
  }

  function salvar() {
    if (!sujo) return;
    try {
      D.minutosAtivos = Math.round((Date.now() - D.inicio) / 60000);
      localStorage.setItem(CHAVE, JSON.stringify(D));
      sujo = false;
    } catch (e) {
      // cota estourada: corta o que é grande e tenta de novo
      try {
        D.cruas = D.cruas.slice(-50);
        localStorage.setItem(CHAVE, JSON.stringify(D));
        sujo = false;
      } catch (e2) { /* desiste desta rodada */ }
    }
  }
  setInterval(salvar, SALVAR_A_CADA_MS);
  window.addEventListener('beforeunload', salvar);
  document.addEventListener('visibilitychange', () => { if (document.hidden) salvar(); });

  // ---- identificação do pokémon ativo ----
  function guardaPoke(p) {
    if (!p || !p.id) return;
    D.meusPokemon[p.id] = {
      nome: p.name, especie: p.speciesId, nivel: p.level, stats: p.stats || null,
      qualidade: p.quality, ivTotal: p.ivTotal, power: p.power, maxHp: p.maxHp,
      team: !!p.team, leader: !!p.leader, slot: p.slot,
      // Para o breeding: shiny se conserva na cria, e Ditto não cruza. Guardamos
      // defensivamente — se a mensagem não trouxer, fica false e não atrapalha.
      shiny: !!p.shiny, ditto: /ditto/i.test(p.name || ''),
    };
    sujo = true;
  }
  function achaAtivo(heroMaxHp) {
    const cands = Object.values(D.meusPokemon).filter(p => p.maxHp === heroMaxHp);
    if (cands.length === 1) return cands[0];
    if (cands.length > 1) {
      // desempate: vários capturados de nível 1 compartilham maxHp 24
      return cands.find(p => p.leader) || cands.find(p => p.team) || null;
    }
    return null;
  }

  // ---- leitura das mensagens ----
  function comoJson(d) {
    if (typeof d !== 'string') return null;
    try { return JSON.parse(d); } catch (e) {}
    const m = d.match(/^\d+([\s\S]*)$/);
    if (m) { try { return JSON.parse(m[1]); } catch (e) {} }
    return null;
  }

  function registrar(dado) {
    let m;
    try { m = comoJson(dado); } catch (e) { return; }
    if (!m || !m.type) return;
    try {
      if (m.type === 'pokes' && Array.isArray(m.list)) { m.list.forEach(guardaPoke); return; }
      if (m.type === 'poke-delta' && m.poke) { guardaPoke(m.poke); return; }
      if (m.type === 'field-init') { hunt = m.slug || null; return; }

      if (m.type === 'catch-result') {
        const k = (m.ballName || '?') + '|' + (m.speciesName || '?');
        const c = D.capturas[k] || (D.capturas[k] = { tent: 0, ok: 0 });
        c.tent++; if (m.success) c.ok++;
        // Fecha o desfecho do shiny derrubado há pouco. Janela de 2 min: o
        // jogador escolhe a bola na mão, não é instantâneo.
        if (shinyCaido && Date.now() - shinyCaido.t < 120000) {
          for (let i = D.shinies.length - 1; i >= 0; i--) {
            const s = D.shinies[i];
            if (s.especie !== shinyCaido.especie || s.desfecho) continue;
            s.desfecho = m.success ? 'capturado' : 'escapou';
            s.bola = m.ballName || null;
            break;
          }
          if (m.success) shinyCaido = null;
        }
        sujo = true; return;
      }

      if (m.type === 'field-kill') {
        const k = m.speciesName || '?';
        const e = D.kills[k] || (D.kills[k] = { n: 0, xpTotal: 0, partes: null, ritmo: {} });
        e.n++; e.xpTotal += m.xpGained || 0;
        if (m.xpParts && !e.partes) e.partes = m.xpParts;
        // Ritmo real de abate, por atacante+nível. Medir é obrigatório porque a
        // espera de respawn varia por mapa (6,2 s no Magnemite, 3,5 s no Onix,
        // ~0 no Larvitar) e ninguém achou modelo que preveja isso — ver TSM-209.
        // Somamos os INTERVALOS entre abates, não a janela inteira: usar
        // (último − primeiro) fazia qualquer pausa do jogador virar "ritmo"
        // (um nv16 real de ~9 s/abate aparecia como 125 s/abate).
        if (!e.ritmo) e.ritmo = {};
        const quem = ativo ? ativo.nome + '|' + ativo.nivel : '?';
        const agora = Date.now();
        const r = e.ritmo[quem] || (e.ritmo[quem] = { n: 0, soma: 0, gaps: 0, pausas: 0, ultimo: 0 });
        if (r.soma === undefined) { r.soma = 0; r.gaps = 0; r.pausas = 0; }  // registro da versão antiga
        if (r.ultimo) {
          const dt = (agora - r.ultimo) / 1000;
          if (dt <= MAX_GAP_ABATE_S) { r.soma += dt; r.gaps++; } else r.pausas++;
        }
        r.n++; r.ultimo = agora;
        sujo = true; return;
      }

      if (m.type !== 'field') return;
      const agora = Date.now();

      if (num(m.heroMaxHp)) { const a = achaAtivo(m.heroMaxHp); if (a) ativo = a; }

      if (Array.isArray(m.mobs)) for (const mo of m.mobs) {
        if (!mo || mo.slot == null) continue;
        const ant = mobs[mo.slot];
        if ((!ant || ant.dead) && !mo.dead) {
          if (mortoEm[mo.slot]) {
            const dt = agora - mortoEm[mo.slot];
            const r = D.respawns;
            r.n++; r.soma += dt;
            if (r.min === null || dt < r.min) r.min = dt;
            if (r.max === null || dt > r.max) r.max = dt;
            delete mortoEm[mo.slot];
          }
          if (num(mo.maxHp)) {
            const k = String(mo.speciesId);
            const s = D.spawns[k] || (D.spawns[k] = { n: 0, soma: 0, min: mo.maxHp, max: mo.maxHp, valores: {} });
            s.n++; s.soma += mo.maxHp;
            if (mo.maxHp < s.min) s.min = mo.maxHp;
            if (mo.maxHp > s.max) s.max = mo.maxHp;
            s.valores[mo.maxHp] = (s.valores[mo.maxHp] || 0) + 1;
          }
          if (mo.shiny && D.shinies.length < 2000) {
            D.shinies.push({ t: agora, especie: mo.speciesId, hunt, maxHp: mo.maxHp });
            // Sinaliza para o painel: shiny na tela AGORA, para você não perder e
            // tirar o print (Win+Shift+S). O jogo é WebGL, então não dá para a
            // extensão capturar a imagem — mas dá para avisar na hora.
            avistadoShiny = { t: agora, especie: mo.speciesId };
          }
          sujo = true;
        }
        if (ant && !ant.dead && mo.dead) {
          mortoEm[mo.slot] = agora;
          // O shiny tem o MESMO id de espécie do bicho normal, então a captura
          // dele não dá para separar pela mensagem. Mas o jogo derruba o shiny e
          // só depois pede a bola ("O shiny caiu! Escolha uma Pokébola"), então a
          // próxima tentativa naquela espécie é a dele.
          if (ant.shiny) shinyCaido = { especie: mo.speciesId, t: agora };
        }
        mobs[mo.slot] = { especie: mo.speciesId, maxHp: mo.maxHp, dead: mo.dead, shiny: mo.shiny };
      }

      if (Array.isArray(m.hits)) for (const h of m.hits) {
        if (!num(h.amount)) continue;
        const alvo = mobs[h.slot];
        if (h.slot === -1 || !alvo) {
          // Guardamos DE ONDE veio o dano: sem a hunt não dá para saber se o
          // jogador sobrevive a um alvo novo, e o ranking acaba recomendando
          // bicho que mata ele (um Tyranitar nv100 para um Machoke nv20).
          acumula(D.danoRecebido, (h.move || '?') + '|' + h.eff + '|' + (hunt || '?'), h.amount);
          // Janela própria, COM carimbo de tempo. Sem ela a cadência do inimigo é
          // incomensurável e o filtro de letalidade fica preso na suposição de que
          // ele bate no mesmo tique que nós — que é justamente o erro do cooldownMs.
          // Janela separada para não roubar espaço da amostra de dano causado.
          D.cruasRecebidas.push({ t: agora, golpe: h.move, eff: h.eff, dano: h.amount, hunt: hunt || null });
          if (D.cruasRecebidas.length > MAX_AMOSTRAS_CRUAS) D.cruasRecebidas.shift();
          sujo = true;
          continue;
        }
        const a = ativo;
        const st = a && a.stats ? a.stats : null;
        // A chave carrega TUDO que a fórmula precisa. Assim cada balde é uma
        // condição experimental fechada: mesmo atacante, mesmos atributos,
        // mesmo golpe, mesmo alvo, mesma efetividade.
        const chave = [
          a ? a.nome : '?', a ? a.nivel : '?',
          st ? st.atk : '?', st ? st.spAtk : '?',
          h.move || '?', h.eff,
          alvo.especie, alvo.maxHp,
        ].join('|');
        acumula(D.baldes, chave, h.amount);
        // Janela DESLIZANTE: interessa o golpe recente, não o do primeiro dia.
        // É daqui que sai o intervalo entre golpes (~1,6 s), e ele precisa ser
        // medido no nível atual do pokémon, não no nível em que a extensão nasceu.
        D.cruas.push({ t: agora, golpe: h.move, eff: h.eff, dano: h.amount,
                       alvo: alvo.especie, alvoHp: alvo.maxHp,
                       atacante: a ? a.nome : null, nivel: a ? a.nivel : null, stats: st });
        if (D.cruas.length > MAX_AMOSTRAS_CRUAS) D.cruas.shift();
        sujo = true;
      }
    } catch (e) { /* nunca quebrar o jogo */ }
  }

  // ---- hook do WebSocket (só recebimento) ----
  const OrigWS = window.WebSocket;
  function Spy(url, protos) {
    const ws = protos === undefined ? new OrigWS(url) : new OrigWS(url, protos);
    ws.addEventListener('message', ev => registrar(ev.data));
    return ws;
  }
  Spy.prototype = OrigWS.prototype;
  Spy.CONNECTING = 0; Spy.OPEN = 1; Spy.CLOSING = 2; Spy.CLOSED = 3;
  window.WebSocket = Spy;

  // =============================================================
  // Otimizador — quem do seu time mata o alvo atual mais rápido.
  // Lê o time e o alvo do próprio socket. O usuário não digita nada.
  // =============================================================
  const temDados = typeof CRIATURAS !== 'undefined' && typeof TIPOS !== 'undefined';

  const amplifica = m => m === 0 ? 0 : m === 1 ? 1 : (m > 1 ? 1 + 1.5 * (m - 1) : m / 1.5);
  function efetividade(tipoGolpe, alvo) {
    const t = TIPOS[tipoGolpe] || {};
    let m = t[alvo.t1] !== undefined ? t[alvo.t1] : 1;
    if (alvo.t2) m *= t[alvo.t2] !== undefined ? t[alvo.t2] : 1;
    return amplifica(m);
  }
  // Fórmula de dano medida e validada (TSM-211 e TSM-215):
  //   FÍSICO   = K · atk        · atk    · poder · efetividade / def
  //   ESPECIAL = K · atk        · spAtk  · poder · efetividade / spDef
  // O especial troca UM dos dois fatores de ataque por spAtk — média geométrica.
  // Vive num lugar só de propósito: estava duplicada em três, e foi por isso que
  // o modelo antigo sobreviveu a duas correções sem ninguém perceber.
  // Nível do PERSONAGEM — é ele que destrava as hunts, não o nível do pokémon.
  // Não aparece em nenhuma mensagem do socket; o jogo só mostra na tela, ao lado
  // do nome ("AllMight · Nível 81 · Golem"). Lemos de lá, com cache: varrer o
  // texto da página é caro e o número muda de hora em hora, não de segundo.
  let nivelCache = null, nivelLidoEm = 0;
  function nivelPersonagem() {
    const agora = Date.now();
    if (nivelCache !== null && agora - nivelLidoEm < 30000) return nivelCache;
    nivelLidoEm = agora;
    try {
      const m = (document.body ? document.body.innerText : '').match(/N[íi]vel\s+(\d+)\s*·/);
      nivelCache = m ? +m[1] : null;
    } catch (e) { nivelCache = null; }
    return nivelCache;
  }

  const K_DANO = 0.007416;
  function danoPrevisto(stats, golpe, ef, alvo) {
    const esp = golpe.c === 'E';
    const ataque = stats.atk * (esp ? stats.spAtk : stats.atk);
    return K_DANO * ataque * golpe.p * ef / (esp ? alvo.spDef : alvo.def);
  }

  // O servidor escolhe por argmax do dano esperado contra AQUELE spawn, com os
  // atributos individuais dele. Aqui só temos a média da espécie: acertamos
  // quando há folga, e erramos em quase-empate — que é exatamente onde o jogo
  // parece "alternar" golpes (TSM-214).
  function golpeEscolhido(atacante, stats, nivel, alvo) {
    let melhor = null, segundo = 0;
    for (const g of atacante.golpes) {
      if (g.lv > nivel) continue;
      const ef = efetividade(g.t, alvo);
      if (!ef) continue;
      const dano = danoPrevisto(stats, g, ef, alvo);
      if (!melhor || dano > melhor.dano) { segundo = melhor ? melhor.dano : segundo; melhor = { ...g, ef, dano }; }
      else if (dano > segundo) segundo = dano;
    }
    // Folga sobre o segundo colocado. Perto de 1 o vencedor muda de bicho para
    // bicho conforme o IV, e aí a previsão de dano do painel fica viesada — foi
    // o que estragou 6 baldes de Karate Chop (erro de −18 a −41%). Melhor avisar
    // que errar em silêncio.
    if (melhor) melhor.folga = segundo > 0 ? melhor.dano / segundo : Infinity;
    return melhor;
  }
  // Intervalo real entre golpes, medido no WebSocket. NÃO é o `cooldownMs` do
  // dado do jogo — golpes de recarga 20 s e 50 s saem os dois a cada 1,6 s.
  const TICK_GOLPE_S = 1.6;
  // Sem ritmo medido não dá para saber a espera de respawn — e inventar um número
  // seria pior que omitir. Zero deixa o tempo como "só combate", e o painel avisa.
  const ESPERA_PADRAO_S = 0;

  // Alvo atual: a espécie mais presente no campo agora.
  function alvoAtual() {
    const cont = {};
    for (const s in mobs) if (mobs[s] && !mobs[s].dead) cont[mobs[s].especie] = (cont[mobs[s].especie] || 0) + 1;
    const ids = Object.keys(cont);
    if (!ids.length) return null;
    const id = +ids.sort((a, b) => cont[b] - cont[a])[0];
    const alvo = CRIATURAS.find(c => c.id === id);
    if (!alvo) return null;
    // HP real observado agora vale mais que a estimativa embutida
    const vivos = Object.values(mobs).filter(m => m && m.especie === id && m.maxHp);
    const hp = vivos.length ? Math.round(vivos.reduce((s, m) => s + m.maxHp, 0) / vivos.length) : alvo.hp;
    return { ...alvo, hp, hpMedido: vivos.length > 0 };
  }

  // Medição vence previsão. Se já registramos esta combinação exata
  // (mesmo pokémon, mesmo nível e ataque, mesmo alvo e mesmo HP), usamos o golpe
  // que o jogo REALMENTE escolheu e o dano REAL — em vez de prever os dois.
  //
  // Isso importa porque a regra de escolha (power × efetividade) FALHOU: no nível 7
  // o jogo usou Agility e no nível 9 trocou para Karate Chop, sem nenhum golpe novo
  // ter desbloqueado e com power × eff apontando para Agility nos dois casos.
  // Agility e Hypnosis são golpes de status na franquia e rendem cerca de metade
  // do dano que o `power` deles sugere — provável causa, ainda não confirmada.
  // Ritmo real de abate, medido: segundos por kill deste atacante contra esta espécie.
  // Só isso é honesto — o jogo alterna golpes de recargas diferentes, e a frequência
  // observada não corresponde a "cada golpe na sua recarga".
  function ritmoMedido(p, alvo) {
    const e = D.kills[alvo.nome];
    if (!e || !e.ritmo) return null;
    const r = e.ritmo[p.nome + '|' + p.nivel];
    // >= em vez de < para não passar com undefined vindo de registro antigo.
    if (!r || !(r.gaps >= 5) || !(r.soma > 0)) return null;
    return { segPorKill: r.soma / r.gaps, n: r.gaps + 1 };
  }

  // Dano por golpe: média PONDERADA de todos os golpes observados contra este alvo,
  // não só o mais frequente. O jogo alterna, então usar um só distorce.
  function medido(p, alvo) {
    const prefixo = [p.nome, p.nivel, p.stats.atk, p.stats.spAtk].join('|');
    let soma = 0, n = 0, dominante = null;
    const golpes = {};
    for (const chave in D.baldes) {
      if (chave.indexOf(prefixo + '|') !== 0) continue;
      const partes = chave.split('|');
      if (+partes[6] !== alvo.id) continue;
      const b = D.baldes[chave];
      soma += b.soma; n += b.n;
      const nome = partes[4];
      golpes[nome] = (golpes[nome] || 0) + b.n;
      if (!dominante || b.n > dominante.n) dominante = { n: b.n, golpe: nome, ef: +partes[5] };
    }
    if (n < 8) return null;
    const at = CRIATURAS.find(c => c.id === p.especie) || CRIATURAS.find(c => c.nome === p.nome);
    const g = at && at.golpes.find(x => x.n === dominante.golpe);
    return {
      dano: soma / n, n,
      variedade: Object.keys(golpes).length,
      golpe: g ? { ...g, ef: dominante.ef } : { n: dominante.golpe, ef: dominante.ef, cd: 0 },
    };
  }

  function ranking() {
    const alvo = alvoAtual();
    if (!alvo) return null;
    const time = Object.values(D.meusPokemon).filter(p => p.stats && p.nivel > 1);
    if (!time.length) return { alvo, itens: [] };
    const itens = time.map(p => {
      const at = CRIATURAS.find(c => c.id === p.especie) || CRIATURAS.find(c => c.nome === p.nome);
      if (!at || !at.golpes.length) return null;

      const obs = medido(p, alvo);
      const ritmo = ritmoMedido(p, alvo);
      let golpe, dano, fonte;
      if (obs) {
        golpe = obs.golpe; dano = obs.dano;
        fonte = 'medido:' + obs.n + (obs.variedade > 1 ? ':alterna' + obs.variedade : '');
      } else {
        golpe = golpeEscolhido(at, p.stats, p.nivel, alvo);
        if (!golpe) return null;
        dano = golpe.dano;
        fonte = 'estimado';
      }
      const base = { nome: at.nome, nivel: p.nivel, golpe, dano, fonte, ritmo,
                     ativo: ativo && ativo.nome === p.nome && ativo.nivel === p.nivel };
      if (!(dano > 0)) return { ...base, dano: 0, seg: Infinity, tempoMedido: false };
      const n = Math.ceil(alvo.hp / dano);
      // Tempo medido vence tempo calculado. O calculado assume um golpe só na
      // recarga dele, e o jogo alterna — foi o que fazia o painel dizer "2min"
      // quando o bicho morria em muito menos.
      if (ritmo) return { ...base, golpes: n, seg: ritmo.segPorKill, tempoMedido: true };
      return { ...base, golpes: n, seg: n * (golpe.cd || 0), tempoMedido: false };
    }).filter(Boolean).sort((a, b) => a.seg - b.seg);
    return { alvo, itens };
  }

  // Melhores caças para o pokémon ATIVO.
  // ATENÇÃO: eu já afirmei aqui que "nível e ataque se cancelam na comparação".
  // É FALSO como o código está. O Math.ceil(hp / dano) logo abaixo é degrau: um
  // erro multiplicativo no dano muda a contagem de golpes, e com ela o tempo, o
  // veredito de overkill e a ordem do ranking. O cancelamento só valeria sem o
  // ceil. Como o expoente do dano segue indeterminado (0,76 a 5,27), a ordem
  // entre alvos NUNCA VISITADOS é palpite — por isso eles vão marcados
  // "não testado" no painel. Onde há medição, ela substitui a fórmula.
  // Só entram alvos com spot no mapa — ver TSM-200.
  // Quanto do tempo entre abates NÃO é combate — esperar o bicho renascer.
  // Sai por subtração: ritmo real medido menos o tempo dos golpes. É o número
  // que revela overkill; sem ele o painel acha que matar em 1 golpe é ótimo,
  // quando na prática o jogador passa a maior parte do tempo parado.
  // Varre TODO histórico de ritmo, não só o do nível atual: a espera é do mapa,
  // não do pokémon. Amarrar ao nível ativo jogava a medição fora a cada level up.
  function esperaEntreAbates() {
    const esperas = [];
    for (const nome of Object.keys(D.kills)) {
      const alvo = CRIATURAS.find(c => c.nome === nome && c.cacavel);
      if (!alvo) continue;
      const ritmo = D.kills[nome].ritmo || {};
      for (const chave in ritmo) {                    // chave = "Nome|nível"
        const r = ritmo[chave];
        if (!(r.gaps >= 5) || !(r.soma > 0)) continue;
        const dano = danoMedidoDe(chave, alvo);
        if (!(dano > 0)) continue;
        const sobra = r.soma / r.gaps - Math.ceil(alvo.hp / dano) * TICK_GOLPE_S;
        if (sobra > 0) esperas.push(sobra);
      }
    }
    if (!esperas.length) return null;
    esperas.sort((a, b) => a - b);
    return esperas[Math.floor(esperas.length / 2)];   // mediana entre alvos/níveis
  }

  // Dano que o jogador leva por golpe, medido. É um PISO: só existe medição das
  // caças que ele já fez, que são as mais fracas que ele enfrentou. Serve para
  // reprovar alvo — se nem apanhando tão pouco ele aguenta o tempo de luta, o
  // alvo mata com folga. O contrário NÃO vale: não ser reprovado não é seguro.
  function danoRecebidoPorGolpe() {
    let soma = 0, n = 0;
    for (const k in D.danoRecebido) { soma += D.danoRecebido[k].soma; n += D.danoRecebido[k].n; }
    return n >= 20 ? soma / n : null;
  }

  // Dano médio de um atacante+nível qualquer contra este alvo, direto dos baldes.
  // Difere de medido() por não depender do pokémon ATIVO — precisa alcançar níveis
  // que o jogador já passou.
  function danoMedidoDe(chaveRitmo, alvo) {
    let soma = 0, n = 0;
    for (const k in D.baldes) {
      if (k.indexOf(chaveRitmo + '|') !== 0) continue;
      if (+k.split('|')[6] !== alvo.id) continue;
      soma += D.baldes[k].soma; n += D.baldes[k].n;
    }
    return n >= 8 ? soma / n : null;
  }

  // Quanto o modelo erra, medido no alvo com mais abates registrados. Vale para
  // todos porque o erro é multiplicativo e comum (VIP, boosts, viés do K).
  function fatorCalibracao(linhas) {
    let ancora = null;
    for (const l of linhas) {
      const alvo = CRIATURAS.find(c => c.nome === l.nome && c.cacavel);
      const real = alvo && l.xps > 0 ? xpPorSegMedido(alvo) : null;
      if (!real) continue;
      if (!ancora || real.abates > ancora.abates) ancora = { abates: real.abates, fator: real.xps / l.xps };
    }
    return ancora && ancora.fator > 0 ? ancora.fator : 1;
  }

  function melhoresCacas(limite) {
    if (!ativo || !ativo.stats) return null;
    const at = CRIATURAS.find(c => c.id === ativo.especie) || CRIATURAS.find(c => c.nome === ativo.nome);
    if (!at || !at.golpes.length) return null;
    const disp = at.golpes.filter(g => g.lv <= ativo.nivel);
    if (!disp.length) return null;

    const med = esperaEntreAbates();
    const espera = med === null ? ESPERA_PADRAO_S : med;
    const esperaEhMedida = med !== null;

    // Quanto tempo o jogador aguenta em pé, pelo piso de dano recebido. Assume
    // que o alvo bate na mesma cadência em que o jogador bate (1,6 s) — mesma
    // engine, mesmo tique. Só usamos isso para REPROVAR alvo, nunca para aprovar.
    const porGolpe = danoRecebidoPorGolpe();
    const segAteMorrer = porGolpe && ativo.maxHp ? ativo.maxHp / (porGolpe / TICK_GOLPE_S) : null;

    const linhas = [];
    for (const alvo of CRIATURAS) {
      if (!alvo.cacavel || !alvo.xp) continue;
      // A hunt é TRANCADA por nível ("Requer nível X" no jogo) — e quem destrava
      // é o nível do PERSONAGEM, não o do pokémon. Filtrar pelo pokémon escondeu
      // o Golem de um jogador que podia caçá-lo.
      // Quando não sabemos o nível do personagem, NÃO filtramos: esconder alvo
      // bom é invisível e caro; sugerir mapa trancado o jogador percebe na hora.
      const nivelJogador = nivelPersonagem();
      if (nivelJogador !== null && alvo.nivel > nivelJogador) continue;
      // melhor golpe disponível contra este alvo (o jogo alterna, então usamos o teto)
      const melhor = golpeEscolhido(at, ativo.stats, ativo.nivel, alvo);
      if (!melhor || !(melhor.dano > 0)) continue;
      const golpes = Math.ceil(alvo.hp / melhor.dano);
      const combate = golpes * TICK_GOLPE_S;
      const seg = combate + espera;
      linhas.push({ nome: alvo.nome, nivel: alvo.nivel, xp: alvo.xp, seg, combate, espera,
                    esperaMedida: esperaEhMedida, xps: alvo.xp / seg,
                    golpe: melhor.n, ef: melhor.ef, golpes,
                    quaseEmpate: melhor.folga < 1.3,
                    // Matar em 1 golpe com sobra é dano jogado fora: o tempo já é
                    // quase todo espera, e subir de nível não acelera mais nada.
                    overkill: golpes <= 1 && espera > combate,
                    letal: segAteMorrer !== null && combate > segAteMorrer,
                    enfrentado: !!D.kills[alvo.nome] });
    }
    // O xp/s daqui sai do MODELO; o número que o painel mostra em cima sai da
    // MEDIÇÃO. Compará-los lado a lado é comparar réguas diferentes — foi o que
    // fez o painel anunciar "rende mais" sobre alvos que rendiam menos (o modelo
    // ignora o VIP, entre outras coisas). Calibramos pelo alvo mais medido: se
    // o modelo erra por um fator ali, erra pelo mesmo fator nos outros.
    const fator = fatorCalibracao(linhas);
    for (const l of linhas) { l.xps *= fator; l.calibrado = fator !== 1; }

    // Letal vai para o fim independente do xp/s: recomendar alvo que mata o
    // jogador é pior que recomendar alvo lento.
    return linhas.sort((a, b) => (a.letal - b.letal) || (b.xps - a.xps)).slice(0, limite || 5);
  }

  const tempo = s => s === Infinity ? 'nunca'
    : s < 60 ? s.toFixed(1) + 's'
    : s < 3600 ? Math.floor(s / 60) + 'min' + (Math.round(s % 60) ? ' ' + Math.round(s % 60) + 's' : '')
    : Math.floor(s / 3600) + 'h ' + Math.round(s % 3600 / 60) + 'min';

  // XP por segundo REAL da caça atual: xp médio por abate ÷ ritmo medido.
  // É o número que o jogador sente no jogo, e não passa por modelo nenhum.
  function xpPorSegMedido(alvo) {
    const k = D.kills[alvo.nome];
    if (!k || !k.n) return null;
    const r = ritmoMedido(ativo, alvo);
    if (!r) return null;
    return { xps: (k.xpTotal / k.n) / r.segPorKill, abates: k.n, seg: r.segPorKill };
  }

  // ---- painel ----
  // Instrumento, não painel de controle. Fica ligado por horas em cima do jogo,
  // então recua visualmente, sai do caminho (arrasta e recolhe) e usa cor com
  // significado: ÂMBAR = medido, cinza = estimado. É a tese do projeto virada em
  // regra visual — o jogador vê na hora em qual número pode confiar.
  const UI = 'piw_ui_v1';
  const pref = (() => { try { return JSON.parse(localStorage.getItem(UI)) || {}; } catch (e) { return {}; } })();
  const gravaPref = () => { try { localStorage.setItem(UI, JSON.stringify(pref)); } catch (e) {} };

  const MONO = 'ui-monospace,Menlo,Consolas,monospace';
  const COR = { fundo: '#0b0f14', sup: '#121a23', linha: '#1c2836',
                txt: '#dde6f0', dim: '#67788c', med: '#ffb340', letal: '#ff6b6b' };
  const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const numero = n => Math.round(n).toLocaleString('pt-BR');

  // XP absoluto do pokémon ATIVO. O jogo mostra "961 / 1884 XP" no card, e o card
  // do ativo tem title "(ativo)"/"(active)". Ler o número exato é muito melhor que
  // medir a velocidade da barra: aquela pegava a primeira barra da tela (podia ser
  // de outro pokémon parado) e extrapolava um ritmo ruidoso — dava tempos absurdos.
  function xpAbsolutoAtivo() {
    try {
      const nos = document.querySelectorAll('[title]');
      for (const n of nos) {
        if (!/\((ativo|active)\)/i.test(n.getAttribute('title') || '')) continue;
        // Ancorar em "…/… XP": o card tem VÁRIOS "X/Y" (HP cheio 1620/1620 vinha
        // ANTES do XP e era pego por engano, dando falta zero -> tempo ~0s).
        const m = (n.textContent || '').match(/([\d.,]+)\s*\/\s*([\d.,]+)\s*E?XP/i);
        if (!m) continue;
        const at = +m[1].replace(/[.,]/g, ''), nx = +m[2].replace(/[.,]/g, '');
        if (nx > 0 && at >= 0 && at <= nx) return { atual: at, prox: nx, falta: nx - at };
      }
    } catch (e) { /* fora do navegador, ou o jogo mudou o layout */ }
    return null;
  }

  // Largura da barra de EXP, com 4 casas ("78.9299%"). Fallback quando não achamos
  // o número absoluto — menos confiável, então marcado.
  function progressoAtivo() {
    try {
      for (const n of document.querySelectorAll('*')) {
        if (!/^EXP\s+\d+%$/.test((n.textContent || '').trim())) continue;
        for (const f of n.querySelectorAll('*')) {
          const w = f.style && f.style.width;
          if (w && w.charAt(w.length - 1) === '%') return parseFloat(w);
        }
      }
    } catch (e) { /* idem */ }
    return null;
  }

  let ancoraProg = null;
  // Tempo até o próximo nível. Prefere XP absoluto ÷ XP/s MEDIDO (exato); só cai
  // na velocidade-da-barra se não achar o número. `xpSeg` vem da medição de combate.
  function faltaParaNivel(xpSeg) {
    const abs = xpAbsolutoAtivo();
    if (abs) {
      const pct = 100 * abs.atual / abs.prox;
      return { pct, falta: 100 - pct, exato: true,
               seg: (xpSeg > 0) ? abs.falta / xpSeg : null };
    }
    const pct = progressoAtivo();
    if (pct === null || !isFinite(pct)) return null;
    const agora = Date.now();
    if (!ancoraProg || pct < ancoraProg.pct - 5) ancoraProg = { pct, t: agora };
    const dp = pct - ancoraProg.pct, dt = (agora - ancoraProg.t) / 1000;
    const falta = 100 - pct;
    return { pct, falta, exato: false, seg: (dp > 0 && dt >= 60) ? falta * dt / dp : null };
  }

  // Resumo da sessão em texto, para o jogador colar no chat do jogo.
  // COPIA, não envia: o cabeçalho deste arquivo promete que nada age no jogo, e
  // é essa promessa que sustenta a autorização da staff. Quem cola é o jogador.
  function resumoTexto() {
    let abates = 0, xp = 0, tent = 0, pegos = 0;
    for (const k in D.kills) { abates += D.kills[k].n; xp += D.kills[k].xpTotal; }
    for (const k in D.capturas) { tent += D.capturas[k].tent; pegos += D.capturas[k].ok; }

    // Ritmo tem que sair do tempo EM CAÇA, não do relógio de parede — senão as
    // horas paradas diluem o número e ele fica 4× menor que a realidade.
    // Numerador e denominador vêm dos mesmos abates: só os que têm ritmo medido.
    let tempoCaca = 0, xpMedido = 0, abatesMedidos = 0;
    for (const k in D.kills) {
      const e = D.kills[k], rit = e.ritmo || {};
      const xpPorAbate = e.n ? e.xpTotal / e.n : 0;
      for (const q in rit) {
        if (!(rit[q].soma > 0) || !(rit[q].gaps > 0)) continue;
        tempoCaca += rit[q].soma;
        abatesMedidos += rit[q].gaps;
        xpMedido += xpPorAbate * rit[q].gaps;
      }
    }

    const nivelJog = nivelPersonagem();
    const l = [];
    if (nivelJog || ativo) {
      l.push('🧑 ' + (nivelJog ? 'Nível ' + nivelJog : 'Treinador') +
             (ativo ? ' · ' + ativo.nome + ' Lv.' + ativo.nivel : ''));
    }
    l.push('⚔️ ' + numero(abates) + ' abates · ✨ ' + numero(xp) + ' XP');
    if (tempoCaca > 600) {
      const hc = tempoCaca / 3600;
      l.push('📈 ' + numero(xpMedido / hc) + ' XP/h · ' + numero(abatesMedidos / hc) +
             ' abates/h · ⏱️ ' + hc.toFixed(1) + 'h em caça');
    }
    if (tent) l.push('🔴 ' + numero(pegos) + '/' + numero(tent) + ' capturas');

    if (D.shinies.length) {
      const pegou = D.shinies.filter(function (s) { return s.desfecho === 'capturado'; }).length;
      const fugiu = D.shinies.filter(function (s) { return s.desfecho === 'escapou'; }).length;
      const partes = [];
      if (pegou) partes.push(pegou + ' capturado' + (pegou > 1 ? 's' : ''));
      if (fugiu) partes.push(fugiu + ' escapou');
      const semDesfecho = D.shinies.length - pegou - fugiu;
      if (semDesfecho) partes.push(semDesfecho + ' sem desfecho');
      l.push('✨ ' + D.shinies.length + ' shiny' + (D.shinies.length > 1 ? 's' : '') +
             ' visto' + (D.shinies.length > 1 ? 's' : '') +
             (partes.length ? ' (' + partes.join(' · ') + ')' : '') +
             ': ' + D.shinies.map(function (s) {
               const c = CRIATURAS.find(function (x) { return x.id === s.especie; });
               return c ? c.nome : '?';
             }).join(', '));
    }

    const r = temDados ? ranking() : null;
    const real = r && r.alvo ? xpPorSegMedido(r.alvo) : null;
    if (r && r.alvo && real) {
      l.push('🎯 ' + r.alvo.nome + ': ' + numero(real.xps) + ' xp/s medido (' + real.seg.toFixed(1) + 's por abate)');
      // A parte que só esta ferramenta sabe dizer: como este mapa se compara.
      const outros = melhoresCacas(400).filter(function (c) { return c.nome !== r.alvo.nome; });
      if (outros.length && real.xps > 0) {
        const razao = real.xps / outros[0].xps;
        l.push(razao >= 1.05 ? '↑ ' + razao.toFixed(1) + '× o melhor alvo que eu alcanço'
             : razao <= 0.95 ? '↓ ' + outros[0].nome + ' renderia ' + (1 / razao).toFixed(1) + '× mais'
             : '= nada que eu alcanço rende mais que aqui');
      }
    }
    return l.join('\n');
  }

  function montarPainel() {
    if (!document.body || document.getElementById('piw')) return;
    const el = document.createElement('div');
    el.id = 'piw';
    el.style.cssText = 'position:fixed;z-index:2147483647;width:264px;' +
      'background:' + COR.fundo + ';color:' + COR.txt + ';border:1px solid ' + COR.linha + ';' +
      'border-radius:10px;font:11.5px/1.45 system-ui,-apple-system,sans-serif;' +
      'box-shadow:0 10px 34px rgba(0,0,0,.55);overflow:hidden;font-variant-numeric:tabular-nums';
    el.innerHTML =
      '<div id="piwCab" style="display:flex;align-items:center;gap:7px;padding:8px 10px;' +
        'background:' + COR.sup + ';border-bottom:1px solid ' + COR.linha + ';cursor:grab;user-select:none">' +
        '<span style="width:6px;height:6px;border-radius:50%;background:' + COR.med + ';flex:none"></span>' +
        '<span style="font-weight:600">Caça</span>' +
        '<span id="piwResumo" style="margin-left:auto;font-family:' + MONO + ';color:' + COR.dim + ';font-size:11px"></span>' +
        '<button id="piwDobra" style="background:none;border:0;color:' + COR.dim + ';cursor:pointer;font:inherit;padding:0 2px;line-height:1">–</button>' +
      '</div>' +
      '<div id="piwCorpo">' +
        '<div id="piwAqui" style="padding:9px 10px"></div>' +
        '<div id="piwCacas" style="padding:0 10px 9px"></div>' +
        '<div style="display:flex;align-items:center;gap:6px;padding:7px 10px;' +
          'border-top:1px solid ' + COR.linha + ';color:' + COR.dim + ';font-size:10.5px">' +
          '<span id="piwConta" style="font-family:' + MONO + '"></span>' +
          '<button id="piwCopiar" style="margin-left:auto;background:none;border:1px solid ' + COR.linha +
            ';color:' + COR.dim + ';border-radius:5px;padding:2px 7px;cursor:pointer;font:inherit"' +
            ' title="copia o resumo da sessão para você colar no chat">Copiar</button>' +
          '<button id="piwBaixar" style="background:none;border:1px solid ' + COR.linha +
            ';color:' + COR.dim + ';border-radius:5px;padding:2px 7px;cursor:pointer;font:inherit">Baixar</button>' +
          '<button id="piwZerar" style="background:none;border:1px solid ' + COR.linha +
            ';color:' + COR.dim + ';border-radius:5px;padding:2px 7px;cursor:pointer;font:inherit">Zerar</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(el);

    const q = id => el.querySelector('#' + id);
    const cab = q('piwCab'), corpo = q('piwCorpo'), resumo = q('piwResumo');

    // Posição guardada entre sessões e presa dentro da janela, para o painel
    // nunca acabar fora da tela depois de redimensionar.
    function poe(x, y) {
      const L = Math.max(4, Math.min(x, (window.innerWidth || 1200) - 60));
      const T = Math.max(4, Math.min(y, (window.innerHeight || 800) - 40));
      el.style.left = L + 'px'; el.style.top = T + 'px';
      el.style.right = 'auto'; el.style.bottom = 'auto';
      pref.x = L; pref.y = T;
    }
    if (typeof pref.x === 'number') poe(pref.x, pref.y);
    else { el.style.right = '12px'; el.style.bottom = '12px'; }

    let arrasto = null;
    cab.addEventListener('pointerdown', function (ev) {
      if (ev.target && ev.target.id === 'piwDobra') return;
      const r = el.getBoundingClientRect();
      arrasto = { dx: ev.clientX - r.left, dy: ev.clientY - r.top };
      cab.style.cursor = 'grabbing';
      if (cab.setPointerCapture) cab.setPointerCapture(ev.pointerId);
    });
    cab.addEventListener('pointermove', function (ev) {
      if (!arrasto) return;
      poe(ev.clientX - arrasto.dx, ev.clientY - arrasto.dy);
    });
    const solta = function () { if (!arrasto) return; arrasto = null; cab.style.cursor = 'grab'; gravaPref(); };
    cab.addEventListener('pointerup', solta);
    cab.addEventListener('pointercancel', solta);

    function dobra(rec) {
      pref.rec = rec;
      corpo.style.display = rec ? 'none' : '';
      el.style.width = rec ? 'auto' : '264px';
      const b = q('piwDobra');
      if (b) b.textContent = rec ? '+' : '–';
      gravaPref();
    }
    q('piwDobra').addEventListener('click', function () { dobra(!pref.rec); });
    dobra(!!pref.rec);

    q('piwCopiar').addEventListener('click', function () {
      const b = q('piwCopiar');
      const avisa = function (txt) { if (b) { b.textContent = txt; setTimeout(function () { b.textContent = 'Copiar'; }, 1600); } };
      try {
        navigator.clipboard.writeText(resumoTexto())
          .then(function () { avisa('Copiado'); })
          .catch(function () { avisa('Falhou'); });
      } catch (e) { avisa('Falhou'); }
    });

    q('piwBaixar').addEventListener('click', function () {
      salvar();
      const url = URL.createObjectURL(new Blob([JSON.stringify(D, null, 1)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'piw-coleta-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.json';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
    });
    q('piwZerar').addEventListener('click', function () {
      if (!confirm('Apagar todos os dados coletados?')) return;
      D = vazio(); sujo = true; salvar();
    });

    function linhaCaca(c) {
      const marca = c.letal
        ? '<span style="color:' + COR.letal + '" title="a luta dura mais do que você aguenta em pé">☠</span>'
        : c.quaseEmpate
          ? '<span style="color:' + COR.dim + '" title="dois golpes quase empatados: a previsão de tempo aqui é imprecisa">~</span>'
          : !c.enfrentado
            ? '<span style="color:' + COR.dim + '" title="você nunca caçou aqui: risco não medido">·</span>'
            : '';
      return '<div style="display:flex;gap:6px;align-items:baseline;padding:2.5px 0">' +
        '<span>' + esc(c.nome) + '</span>' +
        '<span style="color:' + COR.dim + ';font-size:10px">nv' + c.nivel + '</span>' + marca +
        '<span style="margin-left:auto;font-family:' + MONO + '">' + numero(c.xps) +
          '<span style="color:' + COR.dim + ';font-size:9.5px"> xp/s</span></span></div>';
    }

    function pintar() {
      let golpes = 0; for (const k in D.baldes) golpes += D.baldes[k].n;
      let abates = 0; for (const k in D.kills) abates += D.kills[k].n;
      const h = Math.floor(D.minutosAtivos / 60), mi = D.minutosAtivos % 60;
      // Shiny é o evento raro que o jogador mais quer ver — nunca some do painel.
      q('piwConta').innerHTML = numero(golpes) + ' golpes · ' + numero(abates) + ' abates · ' + h + 'h' + mi + 'm' +
        (D.shinies.length
          ? ' · <b style="color:' + COR.med + '">✨ ' + D.shinies.length + '</b>'
          : '');

      // Banner de shiny na tela: aparece por 30 s para você não perder e printar.
      let bShiny = '';
      if (avistadoShiny && Date.now() - avistadoShiny.t < 30000) {
        const c = CRIATURAS.find(function (x) { return x.id === avistadoShiny.especie; });
        bShiny = '<div style="background:' + COR.med + ';color:#0b0f14;font-weight:700;' +
          'border-radius:6px;padding:5px 7px;margin-bottom:7px;font-size:11px;text-align:center">' +
          '✨ SHINY NA TELA' + (c ? ' — ' + esc(c.nome) : '') + '<br>' +
          '<span style="font-weight:400;font-size:10px">tire o print: Win+Shift+S</span></div>';
      }

      const r = temDados ? ranking() : null;
      const aqui = q('piwAqui'), cacas = q('piwCacas');
      if (!r || !r.alvo) {
        resumo.textContent = 'sem alvo';
        aqui.innerHTML = bShiny + '<span style="color:' + COR.dim + '">esperando uma caça começar…</span>';
        cacas.innerHTML = '';
        return;
      }

      const real = xpPorSegMedido(r.alvo);
      const eu = r.itens.find(function (x) { return x.ativo; }) || r.itens[0];
      resumo.textContent = real ? numero(real.xps) + ' xp/s' : r.alvo.nome;

      aqui.innerHTML = bShiny +
        '<div style="display:flex;align-items:baseline;gap:6px">' +
          '<span style="font-weight:600">' + esc(r.alvo.nome) + '</span>' +
          '<span style="color:' + COR.dim + ';font-size:10px">' + numero(r.alvo.hp) + ' hp' + (r.alvo.hpMedido ? '' : ' ≈') + '</span>' +
          '<span style="margin-left:auto;font-family:' + MONO + ';font-size:15px;color:' +
            (real ? COR.med : COR.dim) + '">' + (real ? numero(real.xps) : '—') + '</span>' +
          '<span style="color:' + COR.dim + ';font-size:10px">xp/s</span>' +
        '</div>' +
        (real
          ? '<div style="color:' + COR.dim + ';font-size:10px;margin-top:1px">' +
              real.seg.toFixed(1) + 's por abate · ' + numero(real.abates) + ' medidos</div>'
          : '<div style="color:' + COR.dim + ';font-size:10px;margin-top:1px">medindo o ritmo…</div>') +
        (function () {
          // XP/s medido do combate: é o que sobe a barra do pokémon que caça.
          const p = faltaParaNivel(real ? real.xps : 0);
          if (!p) return '';
          return '<div style="display:flex;align-items:baseline;gap:5px;margin-top:5px">' +
            '<div style="flex:1;height:3px;background:' + COR.linha + ';border-radius:2px;overflow:hidden">' +
              '<div style="width:' + p.pct.toFixed(1) + '%;height:100%;background:' + COR.med + '"></div></div>' +
            '<span style="color:' + COR.dim + ';font-size:10px;font-family:' + MONO + '">' +
              (p.seg ? tempo(p.seg) : p.falta.toFixed(1) + '%') +
              (ativo ? ' p/ nv' + (ativo.nivel + 1) : ' p/ subir') +
            '</span></div>';
        })() +
        (eu
          ? '<div style="color:' + COR.dim + ';font-size:10px;margin-top:3px">' +
              esc(eu.golpe.n) + ' ×' + eu.golpe.ef.toFixed(2) + ' · ' + eu.golpes +
              ' golpe' + (eu.golpes === 1 ? '' : 's') + ' de ' + numero(eu.dano) + ' · ' +
              '<span style="color:' + (eu.fonte.indexOf('medido') === 0 ? COR.med : COR.dim) + '">' +
                (eu.fonte.indexOf('medido') === 0 ? 'medido' : 'estimado') + '</span></div>'
          : '');

      const lista = temDados ? melhoresCacas(400) : null;
      if (!lista || !lista.length) { cacas.innerHTML = ''; return; }
      const atual = lista.find(function (c) { return c.nome === r.alvo.nome; });
      const outros = lista.filter(function (c) { return c.nome !== r.alvo.nome; });
      // Referência é o xp/s MEDIDO quando existe. A lista já vem calibrada pela
      // mesma medição, então agora as duas colunas estão na mesma régua.
      const aquiXps = real ? real.xps : (atual ? atual.xps : 0);
      const melhores = outros.filter(function (c) { return c.xps > aquiXps * 1.05; });
      const mostra = (melhores.length ? melhores : outros).slice(0, 3);
      const ganho = melhores.length && aquiXps > 0 ? melhores[0].xps / aquiXps : null;

      cacas.innerHTML =
        '<div style="border-top:1px solid ' + COR.linha + ';padding-top:7px;color:' + COR.dim +
          ';font-size:9.5px;letter-spacing:.08em">' +
          (melhores.length ? 'RENDE MAIS' : 'OUTRAS OPÇÕES') + '</div>' +
        mostra.map(linhaCaca).join('') +
        (atual && atual.overkill
          ? '<div style="color:' + COR.med + ';font-size:10px;margin-top:5px">Você mata em 1 golpe e espera ' +
              atual.espera.toFixed(1) + 's. Subir de nível não acelera nada aqui.</div>'
          : ganho && ganho > 1.3
            ? '<div style="color:' + COR.med + ';font-size:10px;margin-top:5px">' + esc(melhores[0].nome) +
                ' renderia ' + ganho.toFixed(1) + '× mais que aqui.</div>'
            : !melhores.length
              ? '<div style="color:' + COR.dim + ';font-size:10px;margin-top:5px">' +
                  'Nada que você alcança rende mais que aqui.</div>'
              : '');
    }
    pintar();
    setInterval(pintar, 2500);
  }
  if (document.body) montarPainel();
  else document.addEventListener('DOMContentLoaded', montarPainel);

  window.__piwColetor = { dados: () => D, salvar,
    ranking: temDados ? ranking : null,
    melhoresCacas: temDados ? melhoresCacas : null,
    resumo: resumoTexto,
    faltaNivel: faltaParaNivel };
})();
