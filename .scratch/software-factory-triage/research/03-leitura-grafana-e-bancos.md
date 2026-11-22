# Leitura de logs do Grafana e de bancos de dados pelo Triador — pesquisa do ticket #4

## 1. Resultado e limites

- Consulta documental: **2026-11-22**. Ticket: [#4](https://github.com/Sanmoo/software-factory-durable/issues/4); mapa: [#1](https://github.com/Sanmoo/software-factory-durable/issues/1).
- **Resposta em uma linha:** a leitura garantida vem da **credencial** (service account do Grafana restrita por datasource; papel de banco só com `SELECT`, de preferência em réplica), nunca do servidor MCP; os servidores MCP acrescentam apenas guardrails de volume, janela e conveniência, e quase todos dizem isso de si mesmos.
- Nenhum servidor MCP avaliado é fronteira de permissão. Os mantidos (mcp-grafana, DBHub, AWS, MCP Toolbox) documentam explicitamente que o controle durável é o privilégio da credencial.
- Limite de janela de tempo e de volume em logs só é **garantido** no Loki (`limits_config` por tenant) ou no token da datasource (Cloud Access Policy com seletor de labels). No mcp-grafana esses limites existem, mas valem apenas se o agente não tiver outro caminho até o Grafana.
- Em PostgreSQL e MySQL, `default_transaction_read_only`/`SET TRANSACTION READ ONLY` são **padrões de sessão que a própria sessão pode desfazer**; a garantia é `GRANT` mínimo, réplica (hot standby) ou `read_only`/`super_read_only`.
- Conteúdo lido é entrada não confiável e pode conter dados pessoais e segredos. A especificação MCP não oferece mecanismo de protocolo contra injeção por resultado de ferramenta; ela pede humano no circuito, que o Triador não tem. A contenção precisa ser estrutural.
- Esta pesquisa não usou credenciais, tenant, modelo nem experimento. Tudo abaixo é leitura de documentação e de código-fonte público; o que depende de comportamento em execução está marcado como **não estabelecido**.

## 2. Fontes e rastreabilidade

Páginas de documentação são mutáveis; repositórios foram lidos em commit fixo (HEAD de `main` na data da consulta).

- **[G1]** [Grafana — Service accounts](https://grafana.com/docs/grafana/latest/administration/service-accounts/)
- **[G2]** [Grafana — Roles and permissions](https://grafana.com/docs/grafana/latest/administration/roles-and-permissions/)
- **[G3]** [Grafana — Data source management](https://grafana.com/docs/grafana/latest/administration/data-source-management/) (permissões de datasource)
- **[G4]** [Grafana — RBAC: actions and scopes](https://grafana.com/docs/grafana/latest/administration/roles-and-permissions/access-control/custom-role-actions-scopes/)
- **[G5]** [Grafana — RBAC: fixed and basic role definitions](https://grafana.com/docs/grafana/latest/administration/roles-and-permissions/access-control/rbac-fixed-basic-role-definitions/)
- **[G6]** [Grafana — LBAC for data sources](https://grafana.com/docs/grafana/latest/administration/data-source-management/teamlbac/)
- **[G7]** [Grafana — Data source HTTP API](https://grafana.com/docs/grafana/latest/developers/http_api/data_source/) (`POST /api/ds/query`, proxy de datasource)
- **[G8]** [Grafana Cloud — Access policies](https://grafana.com/docs/grafana-cloud/security-and-account-management/authentication-and-permissions/access-policies/)
- **[L1]** [Loki — HTTP API](https://grafana.com/docs/loki/latest/reference/loki-http-api/)
- **[L2]** [Loki — referência de configuração, `limits_config`](https://github.com/grafana/loki/blob/acaa752c17c1560eead5a33d04d63ed877d4a6de/docs/sources/shared/configuration.md) (commit `acaa752c`; fonte da página [Configure](https://grafana.com/docs/loki/latest/configure/))
- **[MG]** [grafana/mcp-grafana — README](https://github.com/grafana/mcp-grafana/blob/10ea9d38a5d6b0e4d5202b2834b05a3b9574c66f/README.md) (commit `10ea9d38`; último release `v2.3.0`, 2026-11-10; Apache-2.0)
- **[P1]** [PostgreSQL — Client connection defaults](https://www.postgresql.org/docs/current/runtime-config-client.html) · **[P2]** [SET TRANSACTION](https://www.postgresql.org/docs/current/sql-set-transaction.html) · **[P3]** [SET](https://www.postgresql.org/docs/current/sql-set.html) · **[P4]** [ALTER ROLE](https://www.postgresql.org/docs/current/sql-alterrole.html) · **[P5]** [Privileges](https://www.postgresql.org/docs/current/ddl-priv.html) · **[P6]** [Predefined roles](https://www.postgresql.org/docs/current/predefined-roles.html) · **[P7]** [Hot standby](https://www.postgresql.org/docs/current/hot-standby.html). "current" era a versão 19 na consulta.
- **[M1]** [MySQL 8.4 — Server system variables](https://dev.mysql.com/doc/refman/8.4/en/server-system-variables.html) (`read_only`, `super_read_only`, `sql_select_limit`) · **[M2]** [SET TRANSACTION](https://dev.mysql.com/doc/refman/8.4/en/set-transaction.html) · **[M3]** [Privileges provided](https://dev.mysql.com/doc/refman/8.4/en/privileges-provided.html) · **[M4]** [Account resource limits](https://dev.mysql.com/doc/refman/8.4/en/user-resources.html) · **[M5]** [Optimizer hints](https://dev.mysql.com/doc/refman/8.4/en/optimizer-hints.html) (`MAX_EXECUTION_TIME`)
- **[S1]** [MCP 2025-11-25 — Specification, "Security and Trust & Safety"](https://modelcontextprotocol.io/specification/2025-11-25) · **[S2]** [Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) · **[S3]** [Security Best Practices](https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices)
- Servidores MCP de banco, cada um em commit fixo: **[DH]** [bytebase/dbhub](https://github.com/bytebase/dbhub/tree/b45ab6d1119d2a18454565c949647649cbeaafe2) · **[CD]** [crystaldba/postgres-mcp](https://github.com/crystaldba/postgres-mcp/tree/15c8e33353546148acc2d8bd784551cf3905d1e2) · **[TB]** [googleapis/mcp-toolbox](https://github.com/googleapis/mcp-toolbox/tree/24762d91babd43d91afc3daeeece1cb446266c54) · **[AW]** [awslabs/mcp](https://github.com/awslabs/mcp/tree/253b675b6e565abf0e1f45f1b7244d1b03baa505) · **[BB]** [benborla/mcp-server-mysql](https://github.com/benborla/mcp-server-mysql/tree/b9c714e182422b9f18437242b80cf003adf1c7ea) · **[RA]** [modelcontextprotocol/servers-archived](https://github.com/modelcontextprotocol/servers-archived/tree/9be4674d1ddf8c469e6461a27a337eeb65f76c2e) · **[SB]** [supabase/mcp](https://github.com/supabase/mcp/tree/efe189fe02eb8d0d06eb272eab55e729ca5c70e9) e [Supabase — MCP, riscos de segurança](https://supabase.com/docs/guides/ai-tools/mcp)

Convenção: **garante** = imposto por um sistema que o agente não controla (Grafana, Loki, banco); **anuncia** = afirmado em README ou imposto só dentro do processo MCP; **não estabelecido** = não foi possível confirmar por leitura.

## 3. Grafana

### 3.1 Credencial: service account, papéis e escopos

- Service accounts são o mecanismo para cargas automatizadas e substituem API keys; o token vale só na organização em que a conta foi criada [G1].
- O papel básico pode ser `None` (desde 10.2.0): "has no permissions by default, and you can grant permissions with RBAC" [G1][G2]. É o ponto de partida de menor privilégio.
- **Tokens não expiram por padrão**; a expiração é opcional na criação e pode ser limitada por `token_expiration_day_limit`. A documentação recomenda vida curta e um token por aplicação [G1].
- Ações de datasource no RBAC: `datasources:read` ("List data sources") e `datasources:query` ("Query data sources"), ambas com escopo `datasources:*` ou `datasources:uid:<uid>` [G4]. O papel fixo `fixed:datasources:reader` concede as duas [G5].
- **RBAC e permissões por datasource existem só em Grafana Enterprise e Grafana Cloud** [G3][G4]. Permissões de datasource (`Query`, `Edit`, `Admin`) podem ser atribuídas a service accounts [G3].
- No Grafana OSS não há restrição por datasource: "By default, any user in an organization can query the data sources in that organization" [G3]. O isolamento possível é por **organização**: uma organização separada contendo só as datasources do Triador, já que o token não atravessa organizações [G1] (composição desta pesquisa, não receita da documentação).
- **`datasources:query` não limita o conteúdo da consulta**: "A user with the `Viewer` role can issue any possible query to a data source, not just queries that exist on dashboards" [G3]. Quem pode consultar a datasource pode pedir qualquer LogQL, qualquer janela e, em datasource SQL, qualquer SQL que a credencial da datasource aceite.
- **Divergência não resolvida:** [G2] e [G3] dizem que Viewer consulta datasources por padrão; a leitura de [G5] indica que o papel básico Viewer só recebe `datasources:query` para a datasource embutida. O comportamento efetivo depende de edição e versão e precisa ser conferido na instalação real (não estabelecido sem tenant).
- `POST /api/ds/query` recebe `from`/`to`, `queries[].datasource.uid`, `maxDataPoints` e `intervalMs`; `/api/datasources/proxy/uid/:uid/*` repassa qualquer chamada à datasource. A página não lista as permissões exigidas por esses dois endpoints [G7] (não estabelecido por essa fonte; [MG] associa `datasources:query` às ferramentas que os usam).

### 3.2 Limitar datasources, labels, janela de tempo e volume

| Camada | O que limita | Quem impõe | Disponibilidade |
| --- | --- | --- | --- |
| Escopo `datasources:uid:<uid>` na service account | Quais datasources | Grafana | Enterprise/Cloud [G4] |
| Cloud Access Policy do token da datasource: escopo `logs:read`, realm `stack`, seletor de labels, sub-redes permitidas, expiração | Leitura apenas; quais streams; de onde; até quando | Grafana Cloud | Cloud [G8] |
| LBAC for data sources | Quais streams, por time | Grafana | Loki: GA em Cloud e em Enterprise com GEL [G6] |
| `limits_config` do Loki, por tenant | Linhas, janela, lookback, bytes, tempo | Loki | Qualquer Loki [L2] |
| Flags do mcp-grafana | Linhas, janela, bytes estimados, matchers | Processo MCP | Qualquer [MG] |

- Cloud Access Policy: `logs:read` é separado de `logs:write` e `logs:delete`; um seletor como `{env="dev"}` faz o token "only be able to query for metrics or logs that include" o label; o realm `stack` prende o token a uma stack [G8]. Como o seletor fica no token da **datasource**, ele vale para todos os usuários dela: o padrão de menor privilégio é uma datasource dedicada ao Triador, com token próprio (composição desta pesquisa).
- LBAC: regras são aplicadas pelas participações do usuário em times; a página **não menciona service accounts** (não estabelecido). Atenção: "users with no LBAC rules on any of their teams can query all logs", e seletores na Cloud Access Policy se sobrepõem às regras de LBAC [G6].
- Limites do Loki, com os padrões da referência [L2]: `max_entries_limit_per_query` = 5000 linhas; `max_query_length` = 30d1h; `max_query_lookback` = 0 (sem limite; quando definido, a consulta é **recortada** em vez de falhar); `max_query_range` = 0; `max_query_series` = 500; `query_timeout` = 1m; `max_query_bytes_read` = 0 e `max_querier_bytes_read` = 150GB, ambos **não aplicados a consultas de log sem filtro**; `required_labels` e `minimum_labels_number` existem. Esses limites são globais ou por tenant (`overrides` no `runtime_config`) [L2]: dar ao Triador limites mais estreitos que os dos humanos exige tenant próprio ou proxy na frente do Loki.
- A API do Loki tem padrões modestos (`limit` = 100, `start` = uma hora atrás), mas são padrões do cliente, não tetos [L1]. "Authorization is not part of the Loki API" [L1]: quem alcança o Loki diretamente lê tudo e alcança também `POST /loki/api/v1/push` e `/loki/api/v1/delete` — o Triador não deve ter rota de rede direta ao Loki.

### 3.3 Servidor MCP oficial (grafana/mcp-grafana)

O que **anuncia** [MG]:

- `--disable-write` ("read-only mode") deixa de registrar as ferramentas de escrita (dashboards, pastas, incidentes, alertas, anotações, snapshots, OnCall) e **também** `query_sql` e `query_influxdb`, porque estas "execute whatever query you give them without inspecting it... `query_sql` will run a `DROP TABLE`". `--enable-query` as devolve "when the datasource credentials are known to be read-only".
- Categorias desligáveis com `--disable-<categoria>`; várias vêm desligadas por padrão (`admin`, `sql`, `cloudwatch`, `elasticsearch`, entre outras) e só entram com `--enabled-tools`.
- Loki: `--max-loki-log-limit` (padrão 100 linhas por chamada de `query_loki_logs`); `--loki-guardrail-mode` (`off` por padrão; `shadow`; `enforce`) com `--loki-guardrail-max-range` (24h) e `--loki-guardrail-max-bytes` (100 GiB, pela estimativa de `index/stats`); `--loki-enforced-matchers`, que acrescenta matchers LogQL a toda consulta, falha fechado em consulta não analisável e exige `--disable-api`.
- A tabela de ferramentas lista a ação e o escopo RBAC mínimos de cada uma; para todas as de Loki: `datasources:query` + `datasources:read` em `datasources:uid:<uid>`.

O que **de fato garante**:

- Nada além do que a service account permite. O próprio README trata as flags como complemento e sugere `Editor` como atalho "less restrictive"; para o Triador esse atalho deve ser recusado.
- `--disable-write` é remoção de ferramentas no processo MCP, não permissão. Se a service account tiver escrita e o agente alcançar o Grafana por outro caminho, nada impede a escrita.
- Os matchers e guardrails têm **desvios documentados**: `grafana_api_request` consulta o proxy da datasource diretamente ("full bypass"), `get_panel_image` renderiza painéis com linhas sem restrição, `ask_assistant` lê o Loki no servidor, snapshots existentes podem conter dados fora da política. O README manda desligar `--disable-api`, `--disable-rendering`, `--disable-assistant` e, se relevante, `--disable-snapshot`.
- O guardrail de custo abre por padrão quando não consegue avaliar a consulta (`--loki-guardrail-on-estimate-failure` = `allow`), e o README registra que o Loki não aplica `max_query_bytes_read` a consultas sem filtro de linha.

**Não estabelecido:** se o servidor marca ou delimita resultados como conteúdo não confiável (o README não menciona injeção de instruções); comportamento real das flags em execução; estabilidade dessas flags entre versões (o README consultado é do HEAD, posterior ao `v2.3.0`).

Configuração candidata para o Triador, derivada do README e ainda sem prova: `--disable-write --disable-api --disable-rendering --disable-assistant --disable-snapshot`, `--enabled-tools` reduzido a `loki` e `datasource`, `--loki-guardrail-mode=enforce` com `--loki-guardrail-on-estimate-failure=block`, `--loki-enforced-matchers` de lista positiva, e token lido de arquivo (`GRAFANA_SERVICE_ACCOUNT_TOKEN_FILE`).

## 4. Bancos de dados

### 4.1 PostgreSQL: o que o servidor garante

- **Privilégios são a garantia.** Nenhum privilégio é concedido a `PUBLIC` em tabelas, colunas, sequências ou schemas; por padrão `PUBLIC` recebe `CONNECT` e `TEMPORARY` no banco e `EXECUTE` em funções [P5]. Um papel de leitura recebe `CONNECT`, `USAGE` no schema e `SELECT` nas tabelas — ou em **colunas** específicas, o que permite esconder dados pessoais [P5]. Convém revogar `TEMPORARY` e revisar `EXECUTE` de funções (recomendação desta pesquisa a partir de [P5]).
- `pg_read_all_data` lê todas as tabelas, views e sequências e **não ignora RLS** [P6]. É amplo demais para menor privilégio. Nunca conceder `pg_read_server_files` ou `pg_execute_server_program`: "could be used to gain superuser-level access" [P6].
- **`default_transaction_read_only` não é fronteira.** O parâmetro "controls the default read-only status of each new transaction" [P1]; `SET` altera parâmetros na sessão, salvo os restritos a superusuário, e a página não restringe este [P1][P3]; "ordinary roles can only set defaults for themselves" via `ALTER ROLE ... SET` [P4]. A sessão pode voltar a leitura e escrita; o que impede a escrita é a falta de `GRANT`. O parâmetro serve de defesa em profundidade e torna o erro explícito.
- Uma transação `READ ONLY` proíbe `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `COPY FROM` em tabelas não temporárias, todo `CREATE`/`ALTER`/`DROP`, `GRANT`, `REVOKE`, `TRUNCATE`, mas "this is a high-level notion of read-only that does not prevent all writes to disk" [P2]. Funções com efeito colateral dependem de privilégio, não do modo da transação.
- **Réplica (hot standby) é a única leitura imposta independentemente de privilégio:** "the parameter `transaction_read_only` is always true and may not be changed"; DML, DDL, `SELECT ... FOR UPDATE`, `nextval()` e `SET transaction_read_only = off` falham [P7]. Custo: consultas longas podem ser canceladas por conflito de replicação após `max_standby_streaming_delay` [P7], e a réplica isola a carga do primário.
- Tempo e concorrência: `statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout` e `transaction_timeout` [P1], aplicáveis por papel com `ALTER ROLE ... SET` [P4]. São padrões de sessão que o papel pode alterar; a documentação não oferece teto imutável por papel. `CONNECTION LIMIT` por papel existe [P4].
- **Limite de linhas não existe no servidor.** A documentação consultada não traz parâmetro que limite linhas retornadas por papel; o teto tem de vir de quem executa a consulta (cursor com `FETCH` limitado, ou reescrita com `LIMIT`).

### 4.2 MySQL: o que o servidor garante

- `SELECT` pode ser concedido global, por banco, por tabela ou por **coluna** [M3]. `FILE` permite ler qualquer arquivo legível pelo servidor e não deve ser concedido [M3].
- `read_only` rejeita atualizações de clientes exceto de quem tem `CONNECTION_ADMIN`/`SUPER`; `super_read_only` rejeita também desses [M1]. É o equivalente à réplica somente leitura e vale para a instância inteira.
- `SET SESSION TRANSACTION READ ONLY` não exige privilégio e "any session is free to change its session characteristics"; em modo `READ ONLY` ainda é possível DML em tabelas `TEMPORARY` [M2]. Como no PostgreSQL, é padrão de sessão, não fronteira.
- `MAX_QUERIES_PER_HOUR`, `MAX_CONNECTIONS_PER_HOUR` e `MAX_USER_CONNECTIONS` são **limites por conta impostos pelo servidor** [M4] — um teto de volume real que o PostgreSQL não tem.
- `max_execution_time` e o hint `MAX_EXECUTION_TIME` valem apenas para `SELECT` somente leitura e são ignorados em stored programs [M5]. `sql_select_limit` limita linhas de `SELECT`, mas é variável de sessão e um `LIMIT` explícito prevalece [M1]: é conveniência, não teto.

### 4.3 Servidores MCP de banco

| Servidor | Anuncia | Garante de fato (leitura do código/doc) | Não estabelecido / ressalvas |
| --- | --- | --- | --- |
| **DBHub** [DH] `v2.1.0`, MIT, ativo | "Guardrails: read-only mode, row limiting, query timeout" | Duas camadas: classificador (PostgreSQL via `libpg-query`, SQL não analisável é rejeitado) e mecanismo do motor — PostgreSQL: `-c default_transaction_read_only=on` na conexão e `BEGIN READ ONLY`; MySQL/MariaDB: `SET SESSION TRANSACTION READ ONLY` + `START TRANSACTION READ ONLY`. Timeout no servidor (`statement_timeout`, `max_execution_time`) com prazo de reserva no cliente. `maxRows` por reescrita com `LIMIT` e linha-sonda de truncamento | Declara: "a guardrail, **not a permission boundary**"; funções como `lo_export`, `dblink`, `LOAD_FILE` não são barradas pelo modo de transação e a lista de bloqueio é "best-effort and not exhaustive"; em TiDB o DDL e em Doris tudo ficam só com o classificador. `readonly` é por ferramenta e não é o padrão fora dos pacotes prontos |
| **Postgres MCP Pro** [CD] `v0.3.0` (2025-05), MIT | "Safe SQL execution"; modo `restricted` para produção | Em `restricted`: validação por AST (`pglast`) com lista de permissão de tipos de nó e de funções, proíbe cláusula de lock e `EXPLAIN ANALYZE`; execução em `BEGIN TRANSACTION READ ONLY` com `ROLLBACK`; timeout de 30 s | **O padrão é `unrestricted`.** O timeout é `asyncio.timeout` no cliente; não foi estabelecido se a consulta é cancelada no servidor. Sem limite de linhas ("presently only execution time"). O README admite que linguagens de procedimento inseguras contornam a proteção. Último release há 18 meses |
| **MCP Toolbox** [TB] `v1.18.0`, Apache-2.0, ativo | "Deterministic read-only... fail-closed" em três camadas | Para Cloud SQL e AlloyDB, parâmetro de conexão `cloudsql_session_read_only=locked` / `alloydb_session_read_only=locked`, que a sessão não desfaz; BigQuery por `dryRun`. A própria página explica por que `SET default_transaction_read_only` e análise de texto falham (`COMMIT;` encadeado, CTE com `DELETE`, funções) | O bloqueio de sessão descrito é de motores gerenciados do Google; **não foi estabelecido** equivalente para PostgreSQL ou MySQL autogeridos. Ferramentas customizadas com SQL parametrizado fixo reduzem a superfície, mas não foram avaliadas aqui |
| **AWS Postgres / MySQL** [AW] Apache-2.0, ativo | Somente leitura quando sem `--allow_write_query` | PostgreSQL: análise com `pglast` e inventário de funções mutantes. MySQL: lista de palavras-chave por texto. `--privilege_check enforce` recusa conexão com superusuário, `rds_superuser` ou `BYPASSRLS` | Declara: "best-effort, defense-in-depth mechanism, **not a security boundary**" e "the database role is the durable guarantee". Voltado a RDS/Aurora; `--privilege_check` tem padrão `warn` |
| **mcp-server-mysql** [BB] MIT | "Read-only by default", "PII redaction" | `SET SESSION TRANSACTION READ ONLY` + `rollback`; escrita só com flags `ALLOW_*`; limite de 100 consultas/min e timeout de 30 s no processo MCP; redação opcional por nome de coluna e regex de valor | Redação é heurística e desligada por padrão. Resistência a comandos encadeados não foi estabelecida; `MYSQL_DISABLE_READ_ONLY_TRANSACTIONS` desliga a proteção |
| **Servidor de referência PostgreSQL** [RA] | "Run a read-only SQL query" | `BEGIN TRANSACTION READ ONLY`, depois `client.query(sql)` com o texto do modelo, sem análise nem parâmetros ([`index.ts` L111–L134](https://github.com/modelcontextprotocol/servers-archived/blob/9be4674d1ddf8c469e6461a27a337eeb65f76c2e/src/postgres/index.ts#L111-L134)) | **Arquivado e sem manutenção.** Pela leitura do código nada impede encerrar a transação dentro do próprio texto; [CD] descreve esse contorno. Não usar |
| **Supabase MCP** [SB] Apache-2.0 | `read_only=true`, escopo por projeto | Segundo a documentação, executa "as a read-only Postgres user"; o código envolve o resultado de `execute_sql` em delimitador de dado não confiável e avisa na descrição da ferramenta para não seguir instruções retornadas | Específico da plataforma Supabase; o papel usado não é nomeado na página. Relevante como exemplo de mitigação, não como candidato geral |

Padrão comum aos servidores mantidos: análise de SQL + transação somente leitura como conveniência e mensagem de erro rápida, e recomendação explícita de papel de menor privilégio. Nenhum deles oferece mascaramento confiável de dados pessoais nem teto de volume que sobreviva a uma credencial ampla.

## 5. Riscos conhecidos

### 5.1 Dados pessoais e segredos

- Quem tem `datasources:query` lê **tudo** o que a datasource expõe [G3]; quem tem `SELECT` lê todas as linhas e colunas concedidas. Logs de aplicação costumam trazer tokens, cabeçalhos e identificadores pessoais; nenhuma fonte consultada promete o contrário.
- Reduções garantidas na origem: seletor de labels no token ou LBAC para excluir streams sensíveis [G8][G6]; `GRANT SELECT` por coluna ou sobre views sem as colunas sensíveis [P5][M3]; RLS, que `pg_read_all_data` não ignora [P6].
- Reduções apenas anunciadas: `--loki-enforced-matchers` [MG] (depende de fechar os desvios da seção 3.3); redação heurística do [BB]; Model Armor, citado no índice de segurança do [TB] e não avaliado.
- Consequência para o Triador (análise desta pesquisa): como o resultado pode ser citado em Ticket público, o conteúdo lido deve ser tratado como sensível até prova em contrário. Preferir citar a consulta, a janela e contagens a transcrever linhas; passar qualquer trecho por redação determinística antes de publicar; e manter trilha de auditoria das consultas — o lado cliente "SHOULD log tool usage for audit purposes" [S2].

### 5.2 Injeção de instruções por conteúdo lido

- Linhas de log e valores de tabela são escritos por terceiros (usuários finais, sistemas externos). A documentação da Supabase descreve exatamente o caso do Triador: um ticket de suporte com instruções embutidas leva o cliente MCP a executar consultas e publicar dados sensíveis na resposta [SB].
- O que a especificação MCP oferece: servidores "MUST sanitize tool outputs"; clientes "SHOULD validate tool results before passing to LLM", "SHOULD prompt for user confirmation on sensitive operations" e "there SHOULD always be a human in the loop with the ability to deny tool invocations" [S2]. Anotações como `readOnlyHint` devem ser consideradas "untrusted unless they come from trusted servers" [S1][S2]. "MCP itself cannot enforce these security principles at the protocol level" [S1].
- [S3] trata de OAuth, confused deputy, passagem de token, SSRF, sequestro de sessão, servidores locais e minimização de escopo. **Não há ali orientação específica para injeção indireta por resultado de ferramenta**; a mitigação fica com o hospedeiro.
- O Triador trabalha sem humano no circuito (decisão do mapa), portanto não cumpre o "SHOULD" central. A compensação precisa ser estrutural (análise desta pesquisa):
  - a credencial só lê, de modo que uma injeção bem-sucedida não altera Grafana nem banco;
  - o servidor MCP e a credencial ficam fora do alcance do agente (fora do Sandbox), para que os limites do servidor não sejam contornáveis e o segredo não possa ser lido nem exfiltrado — [S3] recomenda `stdio` e sandbox com privilégio mínimo para servidores locais;
  - nenhuma ferramenta com efeito colateral além das etiquetas e do comentário de Triagem; a saída pública passa por validação e redação determinísticas;
  - resultados entram no contexto delimitados como dado, como faz [SB]; isso reduz, não elimina, o risco.
- Uma credencial ampla e de vida longa aumenta o dano de qualquer vazamento [S3, "Scope Minimization"]; tokens do Grafana não expiram por padrão [G1].
- Observação desta sessão: uma das páginas de documentação consultadas trazia uma instrução embutida dirigida a agentes, que foi ignorada. O risco não é hipotético nem restrito a logs.

## 6. Recomendações para a spec

Derivadas das fontes acima; nenhuma foi provada em execução.

1. **Modelar a fonte externa como credencial + limites, não como "servidor MCP confiável".** A instalação declara a credencial de menor privilégio; a fábrica não promete leitura segura sobre credencial ampla.
2. **Grafana:** service account com papel `None`, `datasources:read` + `datasources:query` em `datasources:uid:<uid>` das datasources autorizadas (Enterprise/Cloud), token com expiração. Em OSS, organização dedicada. Datasource própria do Triador com token `logs:read` e seletor de labels quando em Cloud.
3. **Volume e janela de logs:** teto no Loki por tenant quando possível; guardrails do mcp-grafana em `enforce` como segunda camada, com todos os desvios desligados.
4. **Bancos:** papel só com `SELECT` em schemas, tabelas ou colunas autorizados, apontado para réplica quando existir; `default_transaction_read_only`, `statement_timeout` e limite de conexões por papel como defesa em profundidade; limite de linhas imposto pela ferramenta. Não habilitar `query_sql` do mcp-grafana sem credencial de datasource comprovadamente somente leitura.
5. **Servidor MCP de banco:** entre os avaliados, DBHub em `readonly = true` e AWS com `--privilege_check enforce` são os que combinam mecanismo do motor com documentação honesta dos limites. A escolha fica para a decisão de modelo de fontes do mapa.
6. **Saída pública:** redação determinística e preferência por referência à consulta em vez de transcrição.

## 7. Não estabelecido e próximos passos

- Comportamento em execução de qualquer flag ou modo citado; em especial, se `--disable-write` + `--disable-api` do mcp-grafana fecham todos os caminhos de escrita e de consulta sem restrição.
- Permissões exigidas por `/api/ds/query` e pelo proxy de datasource na versão do Grafana da instalação, e o que o papel Viewer recebe por padrão (divergência entre [G2][G3] e [G5]).
- Se LBAC for data sources se aplica a service accounts [G6].
- Se existe bloqueio de sessão somente leitura no MCP Toolbox para PostgreSQL/MySQL autogeridos [TB].
- Se o timeout do Postgres MCP Pro cancela a consulta no servidor [CD]; resistência do [BB] a comandos encadeados.
- Texto integral de `max_execution_time` e `transaction_read_only` em [M1] não foi lido (página extensa); as afirmações sobre eles vêm de [M2] e [M5].
- Uma prova real contra uma fonte externa continua listada no mapa como "not yet specified" e exige autorização separada e os guardrails de `docs/agents/experiment-proofs.md`.
