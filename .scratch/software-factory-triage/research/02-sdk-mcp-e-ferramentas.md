# Pesquisa 02: como o SDK do agente admite MCPs e ferramentas customizadas

Ticket: [#3](https://github.com/Sanmoo/software-factory-durable/issues/3), do mapa [#1](https://github.com/Sanmoo/software-factory-durable/issues/1) (Triagem de Tickets com um Triador autônomo).
Data: 2026-11-22. Pesquisa documental: nenhuma credencial usada, nenhum servidor MCP real contatado, nenhum código executado.

## Resposta curta

O `@earendil-works/pi-coding-agent` 1.5.2 admite as três formas pedidas: servidores MCP por stdio e por streamable HTTP (extensão MCP embutida, que uma sessão de SDK precisa adicionar de propósito), extensões, e ferramentas definidas em código (`customTools`, o que a fábrica já usa). Ele oferece lista de permitidas por sessão, exposição por servidor e por ferramenta, ganchos `tool_call`/`tool_result` e um corte fixo de 20 KB no texto de resultados MCP. Ele **não** oferece isolamento: o cliente MCP roda dentro do processo do worker, que na fábrica é um processo host, então por padrão o servidor stdio é um filho do host e o tráfego HTTP sai do host, fora do guest e fora da mediação do Gondolin. "Somente leitura" não é garantido pelo SDK: as anotações MCP são dicas não verificadas. O `@earendil-works/pi-durable` 1.5.0 não tem cliente MCP e a fábrica só o usa como armazenamento do Control.

## Fontes e método

- Pacotes instalados, lidos no disco. O worktree desta pesquisa e o checkout principal não tinham `node_modules`; os arquivos foram lidos em `.worktrees/nightly-full/node_modules`, que tem as mesmas versões fixadas em `package.json:24-33` (`pi-coding-agent` 1.5.2, `pi-durable` 1.5.0, `gondolin` 0.14.0). As citações usam o caminho relativo `node_modules/...:linha`.
- Repositório de origem, público: <https://github.com/earendil-works/pi> (tags `v1.5.0` e `v1.5.2` existem; `packages/coding-agent/docs/mcp.md` existe em `v1.5.2`). Os documentos citados em `node_modules/@earendil-works/pi-coding-agent/docs/` correspondem a <https://github.com/earendil-works/pi/tree/v1.5.2/packages/coding-agent/docs>.
- Especificação MCP, revisão 2025-11-25: [transportes](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), [ferramentas](https://modelcontextprotocol.io/specification/2025-11-25/server/tools), [autorização](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).
- Código da fábrica, para a ligação atual das sessões: `src/workers/worker-session.ts`, `src/sandbox/adapter.ts`, `.scratch/software-factory/spec.md`.

Abreviações nas citações: `PCA` = `node_modules/@earendil-works/pi-coding-agent`, `PMCP` = `node_modules/@earendil-works/pi-mcp`, `PD` = `node_modules/@earendil-works/pi-durable`, `GON` = `node_modules/@earendil-works/gondolin`.

## 1. Formas de registrar ferramentas

### 1.1 Ferramentas definidas em código (`customTools`)

- `createAgentSession` aceita `customTools?: ToolDefinition[]`, registradas além das embutidas (`PCA/dist/core/sdk.d.ts:55-56`).
- Uma `ToolDefinition` tem `name`, `label`, `description`, `parameters` (esquema TypeBox) e `execute(toolCallId, params, signal, onUpdate, ctx)`; opcionalmente `outputSchema`, `exposure`, `namespace`, `annotations`, `defaultActive`, `executionMode` (`PCA/dist/core/extensions/types.d.ts:473-535`).
- É o que a fábrica faz hoje: monta `customTools` por papel e passa a lista de nomes em `tools` (`src/workers/worker-session.ts:241-265` e `:359-367`). O `execute` de cada ferramenta encaminha a chamada ao guest pela projeção do Sandbox (`src/workers/worker-process.ts:50-62`).

### 1.2 Extensões

- Uma extensão é código que roda dentro do processo do Pi (`PCA/docs/security.md:90`) e registra ferramentas com `pi.registerTool(definition)` (`PCA/docs/extensions.md:1582`; tipo em `PCA/dist/core/extensions/types.d.ts:1271`), ganchos com `pi.on(...)` e servidores MCP com `pi.registerMcpServer(name, config)` (`PCA/docs/extensions.md:2800-2809`; tipo em `types.d.ts:1433`).
- Numa sessão de SDK as extensões entram pelo `resourceLoader`. Com o `DefaultResourceLoader`, fábricas em linha vão em `extensionFactories` (`PCA/docs/sdk.md:112`; opções em `PCA/dist/core/resource-loader.d.ts:72-88`, que também tem `noExtensions`, `noSkills`, `noPromptTemplates`, `noThemes`, `noContextFiles`).

### 1.3 Servidores MCP

- Transportes: stdio e streamable HTTP. O SSE legado é recusado (`PCA/docs/mcp.md:3`, `:64`, `:78-79`). A especificação define exatamente esses dois transportes padrão e admite transportes customizados ([transportes](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)).
- O cliente é o `@earendil-works/pi-mcp` 1.5.2, próprio, sem o SDK oficial do MCP; fala a versão `2025-11-25` e aceita `2025-06-18`, `2025-03-26` e `2024-11-05`. Não implementa sampling, tasks nem lotes JSON-RPC (`PMCP/README.md:3`, `:170-187`). É dependência do `pi-coding-agent` (`PCA/package.json:47`), não dependência direta da fábrica.
- **Sessões de SDK não carregam MCP sozinhas.** A CLI carrega `codemode`, `tool_search` e MCP como extensões embutidas; uma sessão de SDK precisa adicionar `createMcpExtension()` (e `createCodemodeExtension()` / `createToolSearchExtension()` conforme a exposição) às `extensionFactories` e chamar `session.bindExtensions()`, porque a extensão conecta os servidores em `session_start` (`PCA/docs/sdk.md:116`; `PCA/docs/mcp.md:272-274`; exemplo em `PCA/examples/sdk/14-codemode-mcp.ts:26-50`). As três fábricas são exportadas pelo pacote (`PCA/dist/index.d.ts:30-34`).
- Configuração de um servidor (`mcpServers`): stdio usa `command`, `args`, `env`, `cwd`; HTTP usa `url`, `headers`, `oauth`; ambos aceitam `timeout`, `enabled`, `exposure`, `toolExposure`, `description` (`PCA/docs/mcp.md:62-71`; tipos em `PCA/dist/core/mcp-servers.d.ts:27-91`).
- Origem da configuração: por padrão, `mcp.json` do diretório do agente e `.pi/mcp.json` do projeto confiável (`PCA/docs/mcp.md:32`). O hospedeiro pode substituir tudo por código: `McpExtensionOptions` aceita `loadConfig`, `createTransport`, `credentials`, `logPath`, `openUrl`, `updateConfig`, `startupWaitMs` (`PCA/dist/extensions/mcp/index.d.ts:33-55`).
- Atenção: o padrão lê o diretório **global** do agente, não o `agentDir` passado a `createAgentSession`. `defaultLoadConfig` usa `getAgentDir()` (`PCA/dist/extensions/mcp/index.js:1203`), que é a variável `PI_CODING_AGENT_DIR` ou `~/.pi/agent` (`PCA/dist/config.js:495`, `:510-516`); o mesmo vale para `mcp-auth.json` (`PCA/dist/extensions/mcp/oauth.js:50`) e `mcp.log` (`index.js:270`). Sem `loadConfig`, `credentials` e `logPath` explícitos, um worker herdaria os MCPs pessoais de quem opera a máquina, o que a spec proíbe (`.scratch/software-factory/spec.md:603-605`).
- Nomes: cada ferramenta vira `mcp__<servidor>__<ferramenta>` (`PCA/docs/mcp.md:77`). Servidores com recursos ganham `list_mcp_resources`, `list_mcp_resource_templates` e `read_mcp_resource` (`PCA/docs/mcp.md:240-246`).

### 1.4 `pi-durable`

- O `pi-durable` 1.5.0 é um harness próprio, marcado experimental (`PD/README.md:3`), com suas ferramentas (`defineTool`, extensões em um registro: `PD/README.md:224-245`) e seu próprio controle de quem chama cada ferramenta (`callers`, `modelTools`: `PD/README.md:333-349`). Não depende do `pi-mcp` (`PD/package.json:160-165`) e o README só cita MCP como algo que o hospedeiro ligaria por conta própria ("an MCP bridge", `PD/README.md:309`).
- A fábrica usa o `pi-durable` apenas no Control, como documentos e armazenamento SQLite (`src/control/durable/store.ts:4`, `src/control/durable/format.ts:7-8`); as sessões dos workers usam o `pi-coding-agent` (`src/workers/worker-session.ts:7-18`).

## 2. Restringir o conjunto de ferramentas e limitar resultados

### 2.1 Conjunto de ferramentas da sessão

- `tools?: string[]` é uma lista de permitidas por nome ou padrão com `*`; `noTools: "all" | "builtin"` suprime os padrões; `excludeTools` é uma lista de negadas aplicada depois, inclusive a MCP (`PCA/dist/core/sdk.d.ts:26-54`).
- Regra específica para MCP: com uma lista de permitidas que não cita nenhum `mcp__`, as ferramentas MCP **continuam registradas** para `codemode` e `tool_search`; só quando alguma entrada começa com `mcp__` a lista passa a filtrar MCP, e uma lista vazia ou `noTools: "all"` desliga MCP também (`sdk.d.ts:40-43`; implementação em `PCA/dist/core/agent-session.js:219-222` e `:1197-1214`). Consequência: `tools: ['read']` sozinho não basta para excluir ferramentas MCP se `codemode` ou `tool_search` estiverem ativos.
- Exposição por servidor (`exposure`) e por ferramenta (`toolExposure`, nomes exatos ou padrões): `codemode` (padrão; chamável só por scripts), `deferred` (declarada após `tool_search`), `direct` (declarada ao modelo como embutida), `hidden` (registrada e inalcançável). `"exposure": "hidden"` com exceções expõe só as ferramentas escolhidas (`PCA/docs/mcp.md:193-224`; `PCA/dist/core/mcp-servers.d.ts:18-46`).
- Em tempo de execução, `pi.setActiveTools(names)` troca o conjunto declarado ao modelo; ignora nomes desconhecidos e `hidden`, e ferramentas `codemode`/`deferred` continuam chamáveis por scripts estejam ativas ou não (`PCA/docs/extensions.md:1908-1938`).

### 2.2 Ganchos de política

- Toda chamada MCP passa pelo pipeline de ferramentas do Pi; ganchos `tool_call` e `tool_result` de extensões valem para MCP, inclusive chamadas feitas de scripts codemode, que carregam `parentToolCallId` (`PCA/docs/mcp.md:254`).
- `tool_call` pode bloquear (`{ block: true, reason }`) ou alterar a entrada; um erro no gancho bloqueia a chamada (`PCA/docs/extensions.md:973-987`, `:3253`; tipo em `types.d.ts:1109-1118`). `tool_result` pode substituir `content`, `details`, `structuredContent` e `isError` (`types.d.ts:1134-1140`), o que permite redigir ou encurtar um resultado antes do modelo.

### 2.3 "Somente leitura"

- O SDK não tem um modo somente leitura para MCP. Ele repassa as anotações que o servidor declara (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) em `pi.getAllTools()`, e a documentação diz que elas não são verificadas (`PCA/docs/mcp.md:256`; `PCA/docs/extensions.md:2772`; `types.d.ts:416-429`). Sem anotação, valem os padrões do MCP: não é somente leitura e pode ser destrutiva.
- A especificação diz o mesmo: clientes devem tratar anotações de ferramentas como não confiáveis, salvo de servidores confiáveis ([ferramentas, "Data Types / Tool"](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)).
- Portanto, leitura garantida só vem de fora do SDK: da credencial (usuário de banco somente leitura, token de escopo mínimo), de uma lista de ferramentas escolhida à mão (`toolExposure`), ou de uma ferramenta customizada que só implementa leitura.

### 2.4 Tamanho dos resultados e tempo

- MCP, ferramentas diretas: texto acima de 20 KB chega ao modelo com o meio removido e um marcador; o texto completo é salvo em arquivo temporário cujo caminho aparece no resultado (`PCA/docs/mcp.md:234`). O limite é uma constante, `MCP_OUTPUT_MAX_BYTES = 20 * 1024` (`PMCP/dist/output-limit.js:6`), sem opção em `McpExtensionOptions` para mudá-lo (`PCA/dist/extensions/mcp/index.d.ts:33-55`). O arquivo é gravado no diretório temporário do processo do worker, modo `0600` (`PCA/dist/utils/output-files.js:10-22`).
- MCP via codemode: o script recebe o `CallToolResult` inteiro, sem corte (`PCA/docs/mcp.md:234-236`; `PCA/dist/extensions/mcp/tools.d.ts:3-9`). O que chega ao modelo é a saída do script, limitada por `max_output_tokens` (padrão 10000), valor que o próprio script declara na linha de opções; o teto rígido é 16.777.216 caracteres (`PCA/docs/codemode.md:9-15`).
- Ferramentas customizadas: o SDK não corta por elas. A documentação exige que a ferramenta trunque a própria saída e exporta `truncateHead`, `truncateTail`, `truncateLine`, com o limite embutido de 50 KB ou 2000 linhas (`PCA/docs/extensions.md:2451-2499`; exportados em `PCA/dist/index.d.ts:26`).
- Tempo: `timeout` por requisição MCP, em segundos, padrão 60, renovado por notificações de progresso (`PCA/docs/mcp.md:68`). Chamadas de ferramenta MCP não são repetidas após erro; leituras de recursos são repetidas uma vez (`PCA/docs/mcp.md:250`).
- Imagens em resultados chegam ao modelo como imagens; outros binários viram arquivo temporário (`PCA/dist/extensions/mcp/tools.d.ts:3-9`).

## 3. Onde ficam as credenciais e se o modelo as lê

### 3.1 Onde ficam

- Estáticas: nos valores de `env` (stdio) e `headers` (HTTP) da entrada do servidor. Os valores aceitam `${VAR}` (lido do ambiente do processo do Pi) e `!comando` (executado no shell do host; o comando precisa ser o valor inteiro) (`PCA/docs/mcp.md:81`; resolução em `PCA/dist/core/resolve-config-value.js:71-73` e `:117-129`). A documentação recomenda manter servidores com credenciais no arquivo de usuário, não no do projeto (`PCA/docs/mcp.md:73`).
- OAuth (só HTTP, servidores sem cabeçalho `Authorization`): tokens em `mcp-auth.json` no diretório do agente, por nome e URL do servidor, com renovação automática (`PCA/docs/mcp.md:129-133`). O armazenamento é injetável (`credentials` em `McpExtensionOptions`, `index.d.ts:38-39`). O login abre um navegador e espera aprovação (`PCA/docs/mcp.md:127`), o que não combina com um Triador sem conversa: o login teria de ser feito antes, pelo operador.
- `auth.provider`: envia ao servidor MCP o token de um provedor de modelo do Pi; proibido em arquivos de projeto (`PCA/dist/core/mcp-servers.d.ts:83-89`).
- A especificação separa os dois casos: autorização OAuth é opcional e vale para transportes HTTP; implementações stdio não devem segui-la e sim obter credenciais do ambiente ([autorização, "Protocol Requirements"](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)).

### 3.2 O modelo consegue lê-las?

- Pelo caminho normal, não: a definição que o modelo vê é montada só com nome, descrição e esquema enviados pelo servidor (`PCA/dist/extensions/mcp/tools.js:187-201`); `env` e `headers` são resolvidos e entregues ao transporte (`PCA/dist/extensions/mcp/runtime.js:53-72`), não ao prompt.
- Mas o SDK não cria uma fronteira. A própria documentação afirma que o Pi lê, altera e executa com as permissões da conta que o iniciou e que a segurança vem de limitar arquivos, credenciais e rede acessíveis (`PCA/docs/security.md:3-7`, `:21`). Caminhos pelos quais um segredo pode chegar ao modelo:
  - uma ferramenta com acesso ao host (um `read` ou `bash` não confinado) leria `mcp.json`, `mcp-auth.json` ou o ambiente do processo;
  - o servidor MCP pode devolver o segredo em um resultado ou mensagem de erro, que vai para o modelo e para o arquivo da sessão (`PCA/docs/security.md:93`);
  - o `stderr` de um servidor stdio que falhou e as notificações de log vão para `/mcp` e `mcp.log` (`PCA/docs/mcp.md:96-98`).
- Inferência (não é afirmação de fonte): na fábrica, as ferramentas do worker são encaminhadas ao guest e não há shell no host (`.scratch/software-factory/spec.md:805-808`), então o primeiro caminho fica fechado enquanto nenhuma ferramenta de host for adicionada; os outros dois dependem do servidor e do filtro de segredos conhecidos da fábrica.
- Vazamento para o **servidor**, não para o modelo: o transporte stdio padrão entrega ao processo filho todo o `process.env` do worker mais o `env` configurado. `StdioTransport` só deixa de herdar com `inheritEnv: false` (`PMCP/dist/transports/stdio.js:81`; opção em `PMCP/dist/transports/stdio.d.ts:8`), e o transporte padrão do `pi-coding-agent` não define essa opção (`PCA/dist/extensions/mcp/runtime.js:66-72`). Para não herdar é preciso fornecer `createTransport`.

## 4. Rede e ambiente isolado

### 4.1 Onde roda cada coisa

- O cliente MCP roda dentro do processo do Pi. Na fábrica esse processo é o worker, um "processo Node host confiável com Pi SDK"; só as ferramentas do repositório executam no guest (`.scratch/software-factory/spec.md:112`).
- stdio: o cliente lança o servidor como subprocesso ([transportes, "stdio"](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)). Com o transporte padrão, o servidor é filho do worker (`PMCP/dist/transports/stdio.js:82-89`), portanto roda no **host**, com a rede do host e as permissões da conta da instalação. Ao parar, o Pi fecha o stdin e mata o grupo de processos (`PCA/docs/mcp.md:102`).
- HTTP: as requisições partem do processo do worker (`PCA/dist/extensions/mcp/runtime.js:56-60`), pela rede do **host**.
- A documentação do Pi descreve exatamente esse arranjo como a forma mais estreita de isolamento: com o Pi fora e só as ferramentas embutidas dentro do ambiente isolado, "other extension tools still run on the host unless they also delegate their work" (`PCA/docs/containerization.md:16`, `:26`, `:183`; tabela em `PCA/docs/security.md:13-17`).
- Scripts codemode rodam em um sandbox QuickJS sem Node, arquivos, rede ou temporizadores; só alcançam o exterior por ferramentas (`PCA/docs/codemode.md:7`). Isso confina o script, não o servidor MCP.

### 4.2 Por onde sai o tráfego

- O guest da fábrica sai por HTTP(S) público mediado pelos ganchos do Gondolin, com DNS sintético, sem WebSockets, SSH, TCP bruto ou entrada, e com os endereços das interfaces do host excluídos (`src/sandbox/adapter.ts:116-143`; `.scratch/software-factory/spec.md:812-813`). Essa mediação vale para o tráfego do guest. Um servidor MCP no host, ou uma requisição HTTP do worker, não passa por ela.
- Consequência para as fontes do mapa: um MCP no host alcança rede privada (Grafana interno, banco em rede privada) sem tocar na política do Sandbox, e também sem a contenção dela.

### 4.3 O que o SDK admite para mover o servidor ou o tráfego

- `createTransport` (um `McpTransportFactory`) substitui os transportes padrão (`PCA/dist/extensions/mcp/index.d.ts:36-37`; `PCA/dist/extensions/mcp/runtime.d.ts:21-22`).
- `PipeTransport`: stdio do MCP sobre um programa iniciado por outra coisa, "for example on another machine"; o hospedeiro fornece `open(handlers)` que devolve `write`, `closeStdin`, `close` e `exited` (`PMCP/README.md:32-46`; `PMCP/dist/transports/pipe.d.ts:3-25`). É o encaixe para rodar o servidor stdio **dentro do guest**.
- `StreamableHttpTransport` aceita `fetch` injetado, "for proxying or custom networking" (`PMCP/README.md:28`; `PMCP/dist/transports/streamable-http.d.ts:26-36`).
- Do lado do Gondolin: segredos por host, em que o guest só vê marcadores e o host substitui o valor real nos cabeçalhos HTTP de saída para os hosts permitidos (`GON/README.md:84-137`), e um mapeamento TCP `guest host[:port] -> upstream host:port` (`GON/dist/src/qemu/tcp.d.ts:1-4`). A fábrica não usa nenhum dos dois hoje (`src/sandbox/adapter.ts:122-143`).
- Ferramenta customizada que delega ao guest, como as atuais (`src/workers/worker-session.ts:241-256`), continua sendo a terceira via: a consulta roda no guest e sai pela rede mediada.

## 5. Ligação atual das sessões na fábrica (fatos)

- O `resourceLoader` é montado à mão e devolve zero extensões (`src/workers/worker-session.ts:187-199`); a spec exige não herdar extensões nem MCP pessoais e incluir recursos adicionais de forma explícita no perfil versionado (`.scratch/software-factory/spec.md:603-605`).
- `createAgentSession` recebe `tools` (lista de nomes), `customTools`, `resourceLoader`, `agentDir: profile.directory` e configurações em memória (`src/workers/worker-session.ts:359-374`). Não há chamada a `bindExtensions` nem menção a MCP em `src/workers/`.
- O SDK que os workers importam (`#factory-pi`) é uma cópia verificada da árvore do `pi-coding-agent` 1.5.2 com correções em `read`, `bash`, `edit` e `write` (`package.json:41-45`; `src/workers/sdk-profile.ts:8-22`, `:158-190`). A cópia é a árvore inteira, então inclui `dist/extensions/mcp`.
- Revisores têm só `read` confinado, sem consulta remota (`.scratch/software-factory/spec.md:806-808`). Um Triador com fontes externas seria o primeiro perfil com ferramentas que alcançam serviços fora do guest e do GitHub.

## 6. O que não foi estabelecido

- Nada foi executado. Não há prova de que `createMcpExtension()` funcione a partir da cópia do SDK em `.scratch/factory-development-sdk-v3` (resolução de `@earendil-works/pi-mcp` e `pi-codemode` a partir desse caminho, exportações no perfil); isso exige um ensaio.
- Se o `resourceLoader` feito à mão da fábrica consegue carregar uma fábrica de extensão em linha, ou se seria preciso trocar para `DefaultResourceLoader` com todas as descobertas desligadas. A documentação só mostra o segundo caminho (`PCA/docs/sdk.md:112-116`).
- Se o Sandbox da fábrica tem uma primitiva de processo com stdin e stdout contínuos que sirva de `McpPipe`. A projeção atual expõe `executeTool` por chamada (`src/workers/worker-process.ts:50-62`); não foi verificado se o Gondolin 0.14.0 e o adapter permitem manter um processo de servidor vivo no guest entre chamadas.
- Como o mapeamento TCP e os segredos por host do Gondolin se comportam com DNS sintético e com a exclusão de endereços do host; os tipos existem, o comportamento não foi lido nem provado. Em particular, não foi estabelecido como um banco de dados (protocolo não HTTP) seria alcançado de dentro do guest.
- Comportamento real da lista `tools` combinada com exposição `direct` de MCP: a leitura do código indica que uma ferramenta MCP `direct` precisa estar na lista para ser declarada (`PCA/dist/core/agent-session.js:1210-1214`), mas isso não foi exercitado.
- Se o filtro de segredos conhecidos da fábrica cobre resultados de ferramentas MCP, `mcp.log` e os arquivos temporários de saída completa. O caminho `[Full output: ...]` aponta para o diretório temporário do host, que um `read` confinado ao guest não alcança; o efeito disso sobre o modelo não foi verificado.
- Servidores MCP concretos (Grafana, bancos): quais ferramentas oferecem, que anotações declaram e que credenciais pedem. Fora do escopo deste ticket.
- Estabilidade da API: a extensão MCP, `PipeTransport` e `McpExtensionOptions` não trazem promessa de compatibilidade nas fontes lidas; o `pi-durable` se declara experimental (`PD/README.md:3`).
