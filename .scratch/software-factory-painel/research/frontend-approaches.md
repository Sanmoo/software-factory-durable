# Pesquisa: abordagens de frontend do Painel contra as restrições da release

Consulta: 2026-11-23. Origem: issue #52 (mapa #51, "Conceber o Painel web v1 da Factory").
Branch descartável `research/painel-frontend-approaches`, sem PR nem merge.

**Este relatório não escolhe a abordagem.** Ele reúne fatos e trade-offs para a decisão que #51 vai tomar.

Método: leitura do repositório nesta árvore (origin/main em 2026-11-23) e de fontes primárias públicas: documentação oficial,
metadados do registry npm (`registry.npmjs.org/<pacote>/latest`) e os arquivos `dist` publicados, baixados de unpkg só para
medir bytes (`wc -c`, `gzip -9`). Não houve instalação no host, protótipo, build nem browser. As versões são as `latest` do
registry na data da consulta. Onde uma fonte não cobre um ponto, o texto diz isso.

Legenda: **Fato** vem de fonte citada ou do código do repositório. **Inferência** é conclusão desta pesquisa e precisa de prova
antes de virar contrato.

## Resumo

- **A. HTML renderizado no servidor (SSR) com JS mínimo** é a opção que encaixa no build atual sem mudar nada no pipeline. O HTML
  sai de funções TypeScript compiladas pelo `tsc` como qualquer outro módulo, o JS de cliente pode ser uma string pequena, e a
  release já copia `dist/src/**/*.js` e o fechamento de `dependencies` do lockfile. Com **htmx** (2.0.11 estável; 4.0.2 na dist-tag
  `next`), soma-se um arquivo de cerca de 13–17 KB gzip, sem dependências, servido de `node_modules`. Polling e confirmação são
  atributos HTML. O custo está na disciplina de escape: logs e saídas capturadas são conteúdo não confiável e o template não
  escapa sozinho.
- **B. SPA compilada no build da release (React/Preact + Vite)** pede um segundo pipeline, porque o `release-build` declara "No
  bundler" e só copia `.js` de `dist/src`. Ela também pede uma toolchain nova de devDependencies (Vite 8 → Rolldown, com binários
  nativos por plataforma), uma API JSON exposta pelo `factory web` e arquivos estáticos que hoje nenhuma regra do
  dependency-cruiser e do ESLint classifica. Em troca, o escape de texto vem por padrão do JSX e a evolução para formulários ricos
  fica natural.
- **Variante intermediária observada:** componentes Preact sem bundler (`preact` + `htm` via import map, ou `.tsx` compilado pelo
  `tsc` com `jsxImportSource: preact`) servidos de `node_modules`. A Preact documenta oficialmente esse caminho. Ele evita o
  bundler, mas não evita a API JSON nem a classificação do código de browser.
- **Testes:** em todas as opções, a renderização (view → HTML ou view → JSON) é testável sem browser no nível unit. O servidor
  HTTP é testável em integration com `node:http` e porta 0. Só o comportamento no browser (polling disparado, swap, roteamento de
  cliente) exige browser real ou DOM simulado. Isso custa mais na SPA, onde a lógica mora no cliente. Playwright 1.65.1 baixa
  browsers próprios (cerca de 281 MB só o Chromium instalado, no exemplo da doc), o que pesa no `test:ci` local.
- **Segredos:** os segredos são filtrados nos Records antes da persistência, e a view de log já sai marcada
  `trust: 'untrusted-captured-output'`. A garantia mais forte é estrutural e independe do frontend: compor o `factory web` só com
  `protocol`/`contracts` numa regra `composition:` do dependency-cruiser, sem alcançar `records` nem `control`.
- **Escrita futura:** Basic auth é uma credencial ambiente. O browser a reenvia sozinho, como um cookie, então CSRF entra em
  jogo nas duas opções. `Sec-Fetch-Site` só chega em origens "potencialmente confiáveis" (HTTPS ou loopback). Num HTTP puro fora
  do loopback ele não aparece, e a verificação de `Origin` passa a ser obrigatória.

## 1. Restrições lidas no repositório (fatos locais)

| # | Fato | Onde |
|---|------|------|
| L1 | A release copia só JavaScript emitido: `copyTree(dist/src → …, path.endsWith('.js'))`. O cabeçalho do build diz: "No bundler, TypeScript runner, `npm install` or download: everything is copied from pinned, verified local inputs." | `src/entrypoints/release-build.ts` (doc do módulo; linha ~359) |
| L2 | Dependências de runtime entram pelo fechamento do `package-lock.json` (`runtimeClosure`) a partir de `dependencies`, com o diretório **inteiro** de cada pacote copiado e inventariado no manifesto (versão, integridade, licença). | `release-build.ts` `runtimeClosure`, laço `closure.keys` |
| L3 | Outros arquivos não-TS entram por cópia explícita e nomeada (`assets/skill-pack`, `assets/lambda`, docs). Um diretório novo de estáticos precisaria de uma linha nova no build e passaria a fazer parte do inventário verificado. | `release-build.ts` linhas ~360–387 |
| L4 | `tsconfig.json`: `module`/`moduleResolution` NodeNext, `target` ES2023, `include` só `**/*.ts` (não `.tsx`), sem `jsx`, `types: ["node"]` e sem `lib` explícito. | `tsconfig.json` |
| L5 | O dependency-cruiser exige que todo arquivo-fonte esteja num caminho **classificado** (`classified-source`, inclusive órfãos, e `classified-source-target`). Os entrypoints compõem zonas declaradas em `compositions` (cli, controller, worker, adapter). Um `src/entrypoints/dashboard*` ou um `.js` de cliente fora desses caminhos falha até o mapa ser estendido. | `.dependency-cruiser.cjs` |
| L6 | O ESLint aplica `recommended` do typescript-eslint e proíbe os identificadores `eval`/`Function`/`require`/`createRequire`/`getBuiltinModule` e o `import()` não literal em **todo** `**/*.{ts,tsx,js,mjs,…}` fora de `node_modules`, `dist`, `.scratch`. Uma biblioteca de browser *vendorizada* no repositório (por exemplo, um `htmx.min.js` em `assets/`) seria linted e tropeçaria nessas regras. A mesma biblioteca lida de `node_modules` não seria. | `eslint.config.mjs` |
| L7 | Protocolo: frame máximo de 64 KiB (`maxFrameBytes`). Páginas de 1–200 itens (`defaultPage: 50`, `maxPage: 200`) e página de log de até 16384 bytes (`logPageBytes`). Uma view que não cabe vira `VIEW_TOO_LARGE`, com `nextStep` que nomeia um comando paginado. | `src/protocol/index.ts`, `src/control/rules/inspection.ts:28`, `src/entrypoints/controller/inspection.ts` |
| L8 | Paginação: `list`, `show`, `history` e `usage` usam `cursor` numérico + `limit`. `logs` usa `after` (id de captura). `log` usa `offset` em bytes, com `nextOffset`. A CLI imprime a view como JSON. | `inspection.ts` (zod `inspectionQuery`), `src/entrypoints/cli.ts` |
| L9 | A view `log` carrega `trust: 'untrusted-captured-output'`. Capturas `raw` nunca são exibidas (`RAW_CAPTURE_NOT_DISPLAYED`). | `src/control/durable/inspection.ts` `inspectLog` |
| L10 | A redação de segredos acontece nos Records, antes de gravar (marcador `█`, função `redact` dos eventos JSONL), alinhada à spec §12.2: "Filtrar segredos conhecidos antes de sessão nativa SDK, arquivos, exibição/publicação controladas…" e "Falha de filtragem não libera bruto por outro caminho." | `src/records/index.ts`; `.scratch/software-factory/spec.md` §12.2 |
| L11 | Níveis de teste: **unit** não alcança I/O (o cruise recusa); **integration** usa processos e sistemas de arquivos reais e porta 0 para servidores; nada de timers fixos (`FACTORY_TEST_DEADLINE`, `test/runner/budget.ts`). | `docs/guides/testing-strategy.md` |
| L12 | Runtime da release: Node 24.21.0 privado (`engines`). As dependências de runtime hoje são 5 (`chord`, `gondolin`, `pi-durable`, `yaml`, `zod`). | `package.json` |

**Inferência (de L1–L3):** qualquer opção cujo artefato de browser não seja um `.js` emitido pelo `tsc` em `dist/src`, nem um
arquivo de um pacote em `dependencies`, exige mudar o `release-build`. Isso vale para um passo de bundler, para a cópia de um
diretório de estáticos ou para os dois. A mudança é pequena para estáticos (o padrão de `assets/*` existe) e maior para um
bundler, que contraria a frase de L1.

## 2. Opções comparadas

- **A1 — SSR + JS mínimo próprio.** O `factory web` responde HTML completo por rota (`/`, `/works`, `/works/:id`,
  `/works/:id/history`…). O polling é um `<meta http-equiv="refresh">` ou umas dezenas de linhas de `fetch` que trocam um
  fragmento.
- **A2 — SSR + htmx.** Mesma topologia. Atributos `hx-get`/`hx-trigger="every Ns"` trocam fragmentos HTML servidos pelo mesmo
  processo.
- **B1 — SPA compilada (React 19 ou Preact 11 + Vite 8).** O `factory web` serve `index.html` + bundle com hash e uma API JSON
  que repassa as views do controlador.
- **B2 — (variante) componentes sem bundler.** Preact + htm por import map, servidos de `node_modules`, ou `.tsx` emitido pelo
  `tsc`. Entra como referência de custo, não como proposta.

### 2.1 Versões e tamanhos (fontes primárias, 2026-11-23)

| Peça | Versão `latest` | Licença | Deps de runtime | Arquivo de browser medido | bytes / gzip -9 |
|------|-----------------|---------|-----------------|----------------------------|-----------------|
| htmx.org | 2.0.11 (dist-tag `next`: 4.0.2, publicada 2026-11-18) [S1][S2] | 0BSD | 0 | `dist/htmx.min.js` 2.0.11 | 52 182 / 16 832 |
| htmx.org | 4.0.2 (`next`) | — | 0 | `dist/htmx.min.js` 4.0.2 | 37 477 / 13 381 |
| preact | 11.2.0 (11.0.0 em 2026-09-30) [S5] | MIT | 0 | `dist/preact.mjs` + `hooks/dist/hooks.mjs` | 11 970 + 3 628 / 4 992 + 1 585 |
| htm | 3.1.1 | Apache-2.0 | 0 | — | — |
| react + react-dom | 19.3.1 | MIT | react-dom: 1 (scheduler) | `react.production.js` + `react-dom-client.production.js` (CJS, antes de bundler) | 18 040 + 625 168 / 4 612 + 110 503 |
| vite | 8.3.8 (Node `^20.19.0 \|\| >=22.12.0`) | MIT | 5 (rolldown, postcss, lightningcss, picomatch, tinyglobby) | — (devDependency) | — |
| rolldown | 1.3.3 | — | 16 bindings nativos opcionais por plataforma | — | — |
| @preact/preset-vite / @vitejs/plugin-react | 2.10.6 / 6.3.0 | MIT | 10 / 1 (+peers oxc/babel) | — | — |
| preact-render-to-string | 6.8.3 | MIT | 0 (peer preact) | — (servidor) | — |

Tamanho desempacotado no npm, que é o que a release copiaria por L2: htmx.org 900 KB (inclui fontes e extensões), preact 624 KB,
react-dom 8,1 MB, hono 1,3 MB, fastify 3,0 MB + 15 deps.

### 2.2 Empacotamento na release autocontida

- **A1 (fato + inferência):** nada novo. Templates e handlers são `.ts` em `src/`, emitidos pelo `tsc`, copiados por L1. O JS e o
  CSS de cliente podem ser constantes string num módulo TS, então também viram `.js` em `dist/src`. Zero dependência de runtime
  nova.
- **A2:** `htmx.org` entra em `dependencies`. O `runtimeClosure` o copia inteiro (900 KB, 0 deps transitivas) e o inventaria com
  licença 0BSD. O servidor lê `node_modules/htmx.org/dist/htmx.min.js` e o serve. Sem bundler. A alternativa de vendorizar o
  arquivo em `assets/` esbarra em L6 (lint) e L5 (órfão não classificado) e precisa de uma linha nova no build (L3).
- **B1:** `vite build` produz `dist/` com `index.html` e assets com hash [S6]. Encaixar isso exige: (i) um passo de build novo
  antes do `release-build`, ou dentro dele, em contradição com "No bundler" (L1); (ii) copiar o diretório de saída para a release
  e inventariá-lo (L3); (iii) devDependencies Vite/Rolldown com binários nativos por plataforma (`@rolldown/binding-linux-x64-gnu`
  etc.). Não vão para a release (não estão em `dependencies`), mas a reprodutibilidade do build passa a depender deles. React e
  Preact também ficariam em devDependencies, porque o bundle já os contém. O alvo padrão do Vite 8 é "Baseline Widely
  Available": Chrome/Edge ≥111, Firefox ≥114, Safari ≥16.4 [S6].
- **B2:** `preact` (e `htm`) em `dependencies`, servidos de `node_modules` com import map [S7]. Sem bundler. Com `.tsx`, o `tsc`
  emite `.js` com `import … from "preact/jsx-runtime"` usando `jsx: react-jsx` + `jsxImportSource: preact` [S8]. Isso pede mudar
  o `include` (só `.ts` hoje, L4) e separar um tsconfig de browser (`lib: dom`, sem `types: node`), com um caminho classificado
  próprio em `dist/`.

### 2.3 Encaixe em TypeScript/ESM, dependency-cruiser e ESLint

- **Comum a todas:** o `factory web` é um entrypoint novo. Ele pede uma entrada em `classified` e uma `composition:` própria.
  A forma natural é `dashboard: ['contracts', 'protocol']`, sem `records`, `control` nem `sandbox`. Pela regra do guia de
  arquitetura, "uma aresta nova entre módulos é uma decisão de arquitetura" e cabe no mapa #51.
- **A1/A2:** o código é todo servidor, Node e ESM, igual ao resto. Templates por template literal tipado **não** escapam
  automaticamente: é preciso um `html\`\`` com escape obrigatório, testado como regra pura. Uma alternativa de autoescape no
  servidor é JSX renderizado em string (`preact-render-to-string` 6.8.3 ou `hono/jsx`). Ela traz `.tsx` e `jsxImportSource`
  para o tsconfig do servidor (L4). htmx não tem tipos nem entra no grafo de imports (é servido como arquivo), então não toca o
  cruise.
- **B1:** o código de browser vive fora do `tsc` atual (Vite transpila com Oxc/Rolldown, e o `tsc --noEmit` só faz typecheck).
  O cruise precisaria de uma zona nova para `web/` ou `src/dashboard-client/`, com regra que a impeça de importar `src/` fora de
  `contracts` (tipos das views). O ESLint precisa de um bloco com globals de browser. As regras de carregamento (L6) continuam
  válidas para código autoral, mas `import()` dinâmico com literal é permitido, e o code-splitting do Vite gera só importações
  literais.
- **B2:** o código de cliente passa por `tsc` e pelo cruise como qualquer `.ts`/`.tsx`. Precisa de uma zona classificada e
  proibida de alcançar `node:*`.

### 2.4 Testes nos níveis da estratégia

| Nível | A1/A2 (SSR) | B1/B2 (cliente) |
|-------|-------------|-----------------|
| **Unit** (sem I/O, L11) | `render(view) → string` é função pura. Afirma escape, presença dos campos de paridade com a CLI e links de paginação (cursor/after/offset). Roda no `node:test` atual. | O mapeamento view → modelo de tela é puro e testável igual. Renderizar componentes pede DOM: `preact-render-to-string` serve sem DOM; `jsdom` 31.0.1 (Node `^22.22.2 \|\| ^24.15.0`) ou `happy-dom` 21.0.4 entram como devDeps se o teste precisar de eventos. |
| **Integration** | `factory web` real numa porta 0 contra um controlador de teste (há o precedente de servidores de inspeção read-only em `inspection.ts`). Afirma HTML, status, cabeçalhos (CSP, auth, 401/403) e que o endpoint do Painel recusa `accept`. Sem browser. | Mesmo teste para a API JSON e para servir os estáticos. A lógica de polling e paginação mora no cliente e **não** é exercitada sem browser ou DOM simulado. |
| **Browser real** | Só para provar o comportamento do htmx (o swap ocorre, o polling para). Como o htmx é atributo declarativo, a afirmação "o HTML tem `hx-trigger="every 5s"`" é verificável sem browser. Inferência: o browser real cabe como receita fora do `test:ci` ou com um cenário por mecanismo. | Necessário para qualquer prova ponta a ponta do produto (roteamento, polling, estado). Playwright 1.65.1 instala browsers próprios em `~/.cache/ms-playwright` (cerca de 281 MB Chromium instalado no exemplo da doc), com deps de sistema via `install-deps` (root) [S9]. Para o `test:ci` local, isso traz download, cache por versão e sensibilidade a timers, que a estratégia proíbe fixar (L11). |

### 2.5 Polling, paginação por cursor e páginas grandes de log

- **Fatos do protocolo (L7–L8):** as views já são limitadas a um frame de 64 KiB, e a paginação é do controlador (`cursor`,
  `after`, `offset`). Nenhuma das opções precisa paginar sozinha: ela traduz parâmetros de URL ou de API para a consulta.
- **A1/A2:** a página é a URL (`/works?cursor=50&limit=50`, `/works/:id/logs/:capture?offset=16384`), o que dá links compartilháveis
  e voltar/avançar do browser sem código. Polling no htmx: `hx-trigger="every 2s"`; o servidor para o polling respondendo HTTP
  **286** [S1]. Um log de 16 KiB por página vira um `<pre>` de no máximo cerca de 16 KiB escapado por resposta. Inferência:
  polling só na página "cabeça" (status, lista, primeira página de log) e páginas antigas estáticas evitam re-render de log
  inteiro. No htmx 4, o histórico deixa de usar snapshot em `sessionStorage` e passa a pedir a página inteira ao navegar [S2],
  o que favorece páginas que funcionam sozinhas.
- **B1/B2:** polling por `setInterval`/`fetch` no cliente, com o estado de cursor na memória ou na URL (o router decide).
  Acumular páginas de log no cliente (scroll infinito) é fácil, mas cresce a memória da aba. A view não é limitada no cliente,
  só por frame. O "instante da observação" pedido em #51 vem do servidor nas duas opções.

### 2.6 Garantia de que nada contorna a filtragem de segredos (spec §12.2)

- **Fato:** a filtragem é feita nos Records antes de gravar (L10), e o controlador entrega as views já filtradas. A spec proíbe
  "liberar bruto por outro caminho".
- **Independe da opção (inferência):** a barreira verificável é a composição. Se `composition:dashboard` permitir só
  `contracts`+`protocol`, o processo do Painel não tem como abrir Records ou SQLite (L5), e um teste de arquitetura pode afirmar
  isso, como os de `test/architecture/`. Somado à política `inspect`-only do endpoint (decisão em #51), o Painel só exibe o que a
  CLI já recebe.
- **Riscos que diferem por opção:**
  - *XSS a partir de saída capturada.* A view de log é `untrusted-captured-output` (L9). Em A1/A2, todo campo interpolado
    precisa de escape. No htmx, um trecho de log com `hx-*` não escapado seria processado: a doc manda escapar e usar
    `hx-disable` em regiões não confiáveis [S1]. Em B1/B2, o JSX escapa texto por padrão, e o risco fica em
    `dangerouslySetInnerHTML`, que uma regra de lint pode proibir.
  - *Superfície de dados.* Em B1, o servidor expõe uma API JSON. Repassar a view inteira do controlador é o mesmo conteúdo da
    CLI, mas é uma segunda forma pública de dados, que futuros campos atravessam sem passar por um template. Em A1/A2, só sai o
    que o template escolhe exibir.
  - *Erros:* o controlador já devolve erros estáveis "never a secret or a stack" (`inspectionErrors`). O servidor HTTP precisa da
    mesma regra para as falhas dele próprio, nas duas opções.
  - *CSP:* SSR com JS mínimo próprio cabe em `default-src 'self'`. O htmx 2 usa `new Function` para `hx-on`, filtros de evento e
    `js:`, e com `allowEval: false` esses recursos desligam [S1]. O htmx 4 traz a extensão `hx-csp` (nonces, Trusted Types,
    `safeEval`) [S2]. O bundle do Vite cabe em `script-src 'self'`.

### 2.7 Escrita futura (formulários, CSRF, confirmação)

- **Credencial ambiente.** A autenticação decidida em #51 é usuário e senha simples. Em HTTP Basic, o cliente "MAY preemptively
  send" o `Authorization` para todo o espaço de proteção [S10]. Inferência: um site terceiro pode disparar um POST para o Painel
  e o browser anexa a credencial, como faria com um cookie de sessão. CSRF precisa de defesa explícita quando a escrita chegar,
  em qualquer opção.
- **Defesas (OWASP) [S11]:** synchronizer token para aplicações com estado; Fetch Metadata (`Sec-Fetch-Site`) como "lightweight
  and reliable method to block obvious cross-site requests", com fallback de verificação de `Origin` "mandatory"; header
  customizado em AJAX, que força preflight CORS; reautenticação ou confirmação para operações críticas.
- **Restrição desta instalação:** `Sec-Fetch-Site` "is only included in requests to potentially trustworthy URLs" [S12], que são
  `https`, `127.0.0.0/8`, `::1` e `localhost` [S13]. A fábrica serve só HTTP (o TLS fica com a operação). Atrás de um proxy TLS o
  browser envia o header; num `http://<ip-da-LAN>` não envia, e então só sobra `Origin`/token. O middleware CSRF do Hono, por
  exemplo, aceita se `Origin` **ou** `Sec-Fetch-Site` passar, e só para métodos inseguros com content-types de formulário [S14].
- **A1/A2:** formulários HTML nativos com token escondido. O htmx manda `hx-headers` com `X-CSRF-TOKEN` no `<body>` [S1].
  `hx-confirm` dá a confirmação mínima, e o evento `htmx:confirm` permite diálogo próprio assíncrono [S1]. O padrão "plan →
  confirm" que a CLI já usa (`cleanup`/`cleanup-confirm`, `forget`/`forget-confirm`) vira duas páginas ou dois fragmentos, sem
  JS de estado.
- **B1/B2:** `fetch` com header customizado + verificação de `Origin`. Com isso o preflight CORS já barra o cross-site, sem token
  em cookie [S11]. Formulários ricos (validação local, estados intermediários) são naturais. A confirmação é componente, e o
  token ou header fica no cliente.

### 2.8 Servidor HTTP no Node (breve)

- **`node:http` (Node 24):** sem roteamento, parsing de corpo ou cookies. O módulo "deals with stream handling and message parsing
  only" [S3]. Defaults lidos no runtime 24.21.0 do projeto: `requestTimeout` 300 000 ms, `headersTimeout` 60 000 ms,
  `keepAliveTimeout` 5 000 ms, `maxHeaderSize` 16 384. A doc recomenda timeouts não nulos sem proxy reverso e oferece
  `close`/`closeAllConnections` para o encerramento supervisionado [S3]. Zero dependência; Basic auth, CSRF e roteamento ficam a
  cargo do código.
- **Hono 4.13.21 + @hono/node-server 2.1.11:** 0 deps transitivas cada. Traz `hono/basic-auth`, `hono/csrf` e `hono/jsx` (render
  com autoescape no servidor). Acrescenta 1,3 MB + 142 KB desempacotados à release.
- **Fastify 5.12.8:** 15 deps diretas (pino, ajv, find-my-way…), 3,0 MB desempacotado.
- **Express 5.3.0:** 28 deps diretas.
- Inferência: para cerca de 6 rotas GET só de leitura, `node:http` mais um roteador de tabela cobre o caso. Um framework passa a
  pagar quando chegarem escrita, CSRF e parsing de formulário. O fechamento de deps entra inteiro no manifesto da release (L2).

## 3. Quadro de trade-offs

| Critério | A1 SSR + JS próprio | A2 SSR + htmx | B1 SPA (Vite) | B2 Preact sem bundler |
|----------|---------------------|---------------|---------------|------------------------|
| Mudança no `release-build` | nenhuma | nenhuma (dep em `dependencies`) | passo de bundler + cópia de estáticos (contraria "No bundler") | nenhuma ou cópia de estáticos; tsconfig de browser |
| Deps de runtime novas | 0 | 1 (0 transitivas) | 0 em runtime; toolchain dev nova (Vite/Rolldown nativo) | 1–2 (preact, htm) |
| Bytes no browser (gzip) | só o próprio | ~13–17 KB | Preact ~7 KB / React ~115 KB + app | ~7 KB + app |
| Cruise/ESLint | entrypoint + composição | idem | + zona de cliente, globals de browser, saída fora do `tsc` | + zona de cliente com tsconfig próprio |
| Escape por padrão | não (helper obrigatório) | não (+ `hx-disable`) | sim (JSX) | sim (JSX/htm) |
| Teste sem browser | quase tudo | quase tudo (atributos afirmáveis) | só a API e a lógica pura | só a API e a lógica pura |
| Polling / paginação | URL + refresh/fetch | `every Ns`, 286 para parar | código de cliente | código de cliente |
| Escrita futura | formulários nativos + token | + `hx-confirm`, `hx-headers` | formulários ricos, header customizado | idem B1 |

## 4. Lacunas e cautelas

- Nenhum número aqui foi medido num protótipo. Os tamanhos são de arquivos publicados (gzip -9 local), não de um bundle da
  aplicação.
- O htmx tem duas linhas vivas: 2.0.11 (`latest`, publicada 2026-09-22) e 4.0.2 (`next`). A doc da 4 não declara a própria
  estabilidade [S2], e a escolha de linha afeta CSP, herança de atributos e histórico.
- A página da Preact sobre no-build mostra import map apontando para CDN (esm.sh) [S7]. Servir de `node_modules`, como a release
  exige, é inferência: não está documentado lá.
- Pontos sem cobertura nas fontes lidas: a OWASP não trata Basic auth especificamente [S11], e a RFC 7617 não trata cache de
  credencial nem logout no browser [S10]. A consequência para CSRF é inferência.
- O "Secure Contexts" consultado é Editor's Draft (2023-11-10) [S13].
- Não foi verificado se o runner de testes (`scripts/test-runner/policy.json`) aceitaria um quality gate com browser. Isso fica
  com a decisão de estratégia de testes do mapa.

## Fontes

- [S1] htmx 2.x docs (exemplos em 2.0.11): polling, security, CSRF, `hx-confirm`, history. https://htmx.org/docs/ — consultado 2026-11-23. Versões e datas: https://registry.npmjs.org/htmx.org
- [S2] htmx 4.0 docs (instalação 4.0.2; migração 2→4, `hx-csp`, `mode: same-origin`). https://four.htmx.org/docs/ — 2026-11-23
- [S3] Node.js v24.x `http` (página em v24.22.3): timeouts, `close*Connections`, "stream handling and message parsing only". https://nodejs.org/docs/latest-v24.x/api/http.html — 2026-11-23. Defaults conferidos no Node 24.21.0 do projeto.
- [S4] Registry npm, metadados `latest` (versão, licença, deps, `unpackedSize`, `engines`) de htmx.org, preact, htm, react, react-dom, vite, rolldown, @preact/preset-vite, @vitejs/plugin-react, preact-render-to-string, hono, @hono/node-server, fastify, express, playwright, jsdom, happy-dom. https://registry.npmjs.org/ — 2026-11-23
- [S5] Arquivos publicados medidos via unpkg: `htmx.org@2.0.11/dist/htmx.min.js`, `htmx.org@4.0.2/dist/htmx.min.js`, `preact@11.2.0/dist/preact.mjs`, `preact@11.2.0/hooks/dist/hooks.mjs`, `react@19.3.1/cjs/react.production.js`, `react-dom@19.3.1/cjs/react-dom-client.production.js`. https://unpkg.com/ — 2026-11-23
- [S6] Vite 8 (seletor v8.3.7), "Building for Production": saída, alvo Baseline, `base`, Rolldown. https://vite.dev/guide/build — 2026-11-23
- [S7] Preact v11, "No-Build Workflows": import maps, HTM. https://preactjs.com/guide/v11/no-build-workflows/ — 2026-11-23
- [S8] TSConfig reference, `jsx` e `jsxImportSource`. https://www.typescriptlang.org/tsconfig/#jsx — 2026-11-23
- [S9] Playwright, "Browsers": install, `install-deps`, cache, `PLAYWRIGHT_BROWSERS_PATH`. https://playwright.dev/docs/browsers — 2026-11-23 (versão do pacote 1.65.1 por [S4])
- [S10] RFC 7617, The 'Basic' HTTP Authentication Scheme, §2.2 "Reusing Credentials". https://www.rfc-editor.org/rfc/rfc7617.html — 2026-11-23
- [S11] OWASP Cross-Site Request Forgery Prevention Cheat Sheet. https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html — 2026-11-23
- [S12] MDN, `Sec-Fetch-Site`. https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Sec-Fetch-Site — 2026-11-23
- [S13] W3C Secure Contexts, Editor's Draft 2023-11-10, §3.1 "Is origin potentially trustworthy?". https://w3c.github.io/webappsec-secure-contexts/ — 2026-11-23
- [S14] Hono, CSRF Protection middleware. https://hono.dev/docs/middleware/builtin/csrf — 2026-11-23
- Repositório (origin/main em 2026-11-23): `src/entrypoints/release-build.ts`, `tsconfig.json`, `.dependency-cruiser.cjs`, `eslint.config.mjs`, `package.json`, `docs/guides/{architecture,coding-standards,testing-strategy}.md`, `src/protocol/index.ts`, `src/entrypoints/controller/inspection.ts`, `src/control/durable/inspection.ts`, `src/control/rules/inspection.ts`, `src/records/index.ts`, `.scratch/software-factory/spec.md` §12.1–12.2.
