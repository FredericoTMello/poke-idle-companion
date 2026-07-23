# Poke Idle Companion

Uma extensão de navegador que **mede a sua caça** em [Poke Idle World](https://poke.idleworld.online) e mostra, em tempo real, o que o jogo não te conta: quanto XP por segundo você está realmente fazendo, quando você está em *overkill*, para onde vale mudar, e — decifrado por medição — como o dano e o breeding funcionam por baixo.

> **Somente leitura.** A extensão escuta o que o servidor já manda para o seu navegador e organiza num painel. Ela **não envia nada**, não clica, não joga por você. Feita com autorização da equipe do jogo. Os detalhes estão em [Princípios](#princípios--o-que-esta-extensão-nunca-fará).

---

## Por que ela existe

Um dia farmando, dava para sentir que subir de nível tinha parado de ajudar, sem saber dizer se era impressão. A extensão nasceu para responder isso com número. E respondeu: o jogador estava matando o alvo em um golpe e passando **82% do tempo esperando o respawn**. Trocar de alvo levou a farm de 59 para 524 XP/s — quase 9×.

Nenhuma calculadora estática consegue ver isso, porque só existe **medindo o combate ao vivo**. É o que esta ferramenta faz.

## O que ela mostra

- **XP por segundo real** da caça atual — medido (xp por abate ÷ ritmo real), não estimado.
- **Aviso de overkill** — quando você mata rápido demais e o respawn virou o gargalo.
- **Para onde mudar** — os alvos que rendem mais, respeitando o seu nível de acesso e o que você aguenta em pé.
- **Quanto falta para o próximo nível**, com tempo estimado pelo seu próprio ritmo.
- **Planejador de breeding** — qual par cruzar, o que o filho projetado terá, e o que você perde (os pais são consumidos).
- **Resumo da sessão** para copiar e colar no chat.

Uma regra de cor atravessa tudo: **âmbar = número medido; cinza = número estimado**. Você sempre sabe em qual confiar.

## Instalação

Não há release nem instalador — **por escolha**. Você carrega a extensão a partir do código, o que garante que você viu o que está rodando. Leva um minuto:

1. Baixe este repositório (botão verde **Code → Download ZIP**, ou `git clone`).
2. Abra `chrome://extensions` no Chrome (ou Edge/Brave).
3. Ligue o **Modo do desenvolvedor** (canto superior direito).
4. Clique em **Carregar sem compactação** e selecione a pasta **`extension/`** deste repositório.
5. Abra ou recarregue [Poke Idle World](https://poke.idleworld.online/play). O painel aparece no canto — arraste-o para onde quiser.

Para atualizar depois: baixe a versão nova, e em `chrome://extensions` clique no botão de recarregar do cartão da extensão, e dê F5 no jogo.

## Como testar o código

O núcleo de cálculo é JavaScript puro, sem dependências, com testes que rodam num navegador simulado:

```bash
cd extension/tests
node teste.js            # coletor, combate, recomendação de caça
node breeding-teste.js   # motor de breeding
```

## Princípios — o que esta extensão nunca fará

Esta é a parte que mais importa, e não vai mudar:

- **Não envia nada ao servidor.** O método de envio do WebSocket não é sequer tocado no código — só escutamos as mensagens que o jogo já manda para desenhar a sua tela. Confira em [`extension/captura.js`](extension/captura.js).
- **Não automatiza.** Sem macro, sem auto-clicker, sem bot. A extensão não simula presença nem executa ações repetidas. Se você fechar o painel, o jogo continua idêntico.
- **Não age por você.** O planejador de breeding **recomenda** um par e mostra a projeção — mas quem seleciona e cruza é você, na interface do jogo. Nenhum botão aqui executa uma ação no jogo.
- **Não dá vantagem de ação** — só de informação. Ela te diz onde você está perdendo tempo; não faz nada mais rápido por você.
- **Não lê nem envia dados de ninguém.** Tudo fica no seu navegador (`localStorage`). Nada sai para lugar nenhum.

O código é aberto justamente para que isso seja **verificável**, não uma promessa. Se algo aqui contradisser esses princípios, é bug — abra uma issue.

## Sobre os dados do jogo

O arquivo [`extension/dados-combate.js`](extension/dados-combate.js) contém stats de criaturas e a tabela de tipos, **propriedade da Quartzz Games LTDA**, extraídos do cliente público do jogo e incluídos apenas para a ferramenta funcionar offline. À disposição da equipe do jogo para remoção a qualquer momento.

## Roadmap e transparência

O que já foi feito, o que está aberto e o que **decidimos não fazer** está em [ROADMAP.md](ROADMAP.md).

## Licença

[MIT](LICENSE) para o código dos autores. Os dados do jogo não são cobertos por ela (ver acima).

---

*Projeto de fã, sem qualquer afiliação com a Quartzz Games LTDA ou com Poke Idle World. "Pokémon" e nomes relacionados pertencem aos seus respectivos donos.*
