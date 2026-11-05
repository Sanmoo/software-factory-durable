# Capacidades e limites do GitHub.com para a Software Factory MVP

- **Consulta:** 2026-11-03 (UTC). Pesquisa documental, sem experimento autenticado.
- **Objeto:** [ticket de pesquisa](../issues/05-github-capabilities.md), sob a [cartografia Wayfinder](../map.md), tendo o [PRD 0.0.1](../prd.md) como autoridade de produto.
- **Escopo:** GitHub.com, APIs públicas documentadas, permissões, políticas de branches e descoberta de efeitos. Não é especificação de implementação nem decisão de credencial, distribuição de autoridade ou configuração dos repositórios.
- **Método:** leitura de documentação oficial, schema OpenAPI oficial, referência GraphQL e documentação-fonte oficial do Git. Nenhum token real foi utilizado; nenhuma instalação, issue, PR, regra ou configuração foi criada/alterada para a pesquisa. A publicação deste relatório é a única operação GitHub de escrita autorizada por este trabalho.
- **Como ler:** **fato documental** descreve a fonte; **implicação** é análise frente ao PRD; **prova pendente** não foi executada. Links `[Sxx]` identificam fontes na seção [Fontes e versões](#fontes-e-versoes). As provas estão em [Provas necessárias](#provas-necessarias).

<a id="sintese"></a>
## 1. Síntese e limites das conclusões

1. **Dependências são relações nativas consultáveis, não uma convenção Markdown.** Há REST `blocked_by`/`blocking` e GraphQL `Issue.blockedBy`/`blocking`. A disponibilidade geral foi anunciada em 2025-08-21, com até 50 relações de cada tipo por issue. O motivo de fechamento distingue `completed`, `not_planned`, `duplicate`, `reopened` e `null` no schema REST atual. Só `closed + completed` atende à regra do PRD para dependência externa. [S01][S02][S03][S04]
2. **Completude e escopo entre owners não estão demonstrados para uma instalação concreta.** As fontes consultadas expõem IDs globais, URLs e contadores, mas não especificam uma garantia suficiente sobre arestas ocultas por permissão, nem uma matriz normativa de dependências entre organizações/contas diferentes. A compatibilidade cross-repo/cross-org precisa de prova com os owners, planos e visibilidades reais; não deve ser presumida a partir da capacidade de endereçar uma issue. [S01][S02][S03][S04]
3. **“Verde” não é apenas a lista de checks que apareceu.** É necessário descobrir regras aplicáveis à base, considerar branch protection tradicional e rulesets herdados, distinguir requisitos ainda sem resultado e correlacionar checks/statuses ao SHA atual e, quando aplicável, ao merge de teste. `mergeable=true` também não atesta todas as políticas. [S05][S06][S07][S08][S09][S10]
4. **Não existe separação suficiente só pelo nome da permissão de token.** `Contents: write`, necessário ao push de trabalho, também habilita os endpoints REST de merge síncrono e assíncrono. Não conceder `Administration: write` não retira esse poder. Impedir de fato push/merge na base exige controle server-side sobre a identidade/refs, ou não entregar ao worker uma credencial GitHub capaz de escrever diretamente. A escolha entre essas possibilidades continua humana e arquitetural. [S11][S12][S13][S14]
5. **A separação por branch é documentalmente possível sob condições, não automática.** `Restrict updates` em ruleset ativo da base permite atualização somente a atores com bypass; branch protection em repositório de organização também permite restringir quem pode fazer push. É necessário excluir a identidade da automação dos bypasses e preservar caminho autorizado para merge humano. Bypass “For pull requests only” **permite merge**; não satisfaz “sem poder de merge”. [S07][S08][S09][S15][S16]
6. **GitHub App installation token e fine-grained PAT não são equivalentes.** App permite identidade independente e token de uma hora, reduzível a repositórios/permissões. PAT age com a identidade/permissões do usuário e limita-se a um resource owner. A documentação atual de PAT registra ausência de suporte à Checks API; a tabela de permissões App inclui leitura de check-runs e a de PAT não. Isso impede declarar PAT sozinho como alternativa comprovadamente completa para RF-09. Não é autorização para escolher App nem para aumentar scopes silenciosamente. [S11][S12][S17][S18][S19]
7. **Recuperação depende de descoberta, não de repetir POST.** PR pode ser procurado por head/base e conferido por IDs; comentários podem ser enumerados e correlacionados a uma pergunta persistida; refs revelam o efeito de um push. Isso não constitui idempotência transacional. Ambiguidade, múltiplos candidatos ou permissões incompletas devem permanecer visíveis. [S05][S20][S21][S22]

<a id="base-documental"></a>
## 2. Base documental e versões

A documentação REST consultada usa `X-GitHub-Api-Version: 2026-03-10`; a página de versões lista também `2022-11-28` como suportada até 2028-03-10 e diz que chamadas sem header ainda usam `2022-11-28`. Logo, exemplos antigos sem header não fixam o contrato analisado aqui. Uma integração futura precisa fixar/testar sua versão; esta pesquisa não provou paridade entre versões. A documentação também admite mudanças aditivas, inclusive novos enums, em versões já existentes: valores desconhecidos não devem ser tratados como sucesso. [S23]

A referência GraphQL consultada está organizada por domínio (`issues`, `pulls`, `checks`, `commits`); as antigas URLs genéricas de `objects`/`enums` levam a um índice, não ao contrato completo. GraphQL não usa o header de versão REST: o recorte aqui é o schema documentado na data da consulta, sujeito a evolução/deprecações. Nenhuma introspecção autenticada foi feita. [S03][S06][S24][S25][S26]

Para tornar o recorte auditável, foram identificados estes commits públicos e confrontados os arquivos relevantes com o conteúdo baixado:

| Fonte versionada | Commit de referência | Uso neste relatório |
| --- | --- | --- |
| `github/docs` | `7fa55a0ac28d01b5cb6f9cbebff06fbee1e2408f` | Front matter de disponibilidade/permissão e reusables de rulesets/bypass. [S04][S15][S16][S27] |
| `github/rest-api-description` | `6348fd455a44a445f9e37a505e981b2c3ed24046` | Schema público `descriptions/api.github.com/api.github.com.json`: operações, enums, parâmetros, limites e visibilidade de bypass. [S14] |
| `git/git` | `ebdc087dc99d68bb340c282b2ba5f722def28d19` | `Documentation/git-push.adoc`: semântica do lease explícito. Não equivale a versão do Git instalada num futuro piloto. [S22] |

As páginas web GitHub.com são documentos vivos; o commit do repositório de docs não prova que cada página renderizada foi gerada exatamente dele. Os links fixados acima preservam os trechos-fonte utilizados, não um snapshot integral do serviço. As limitações e provas abaixo devem ser revalidadas antes de implementação/piloto.

<a id="dependencias"></a>
## 3. Dependências nativas: consulta, completude e conclusão

### 3.1 Superfícies e identidade

| Consulta | Evidência disponível | Permissão/limite documentado |
| --- | --- | --- |
| `GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by` | Lista de issues que bloqueiam a issue, incluindo IDs, URL do repositório, número, estado e `state_reason`. | `Issues: read`, para IAT/UAT de App e fine-grained PAT. `per_page` padrão 30, máximo 100; `page`; códigos incluem 200, 301, 404 e 410. [S01][S11][S12] |
| `GET .../dependencies/blocking` | Relação inversa: issues bloqueadas pela issue consultada. | Mesma necessidade de paginação e acesso; não substitui `blocked_by` na elegibilidade. [S01][S11][S12] |
| GraphQL `Issue.blockedBy` e `Issue.blocking` | `IssueConnection`, com paginação por cursor; `Issue.issueDependenciesSummary`. | Consultar `pageInfo` até `hasNextPage=false`, incluindo conexões aninhadas. `totalBlockedBy` e `totalBlocking` explicitamente incluem abertas e fechadas. [S03][S28] |
| Gestão da relação, apenas para descrever o contrato | REST `POST .../dependencies/blocked_by` usa `issue_id` numérico global; GraphQL usa IDs de nós. | Escrita requer `Issues: write`; UI requer pelo menos triage. O MVP só precisa ler dependências, não receber escrita para geri-las. [S01][S04][S11][S12] |

Issue number só identifica uma issue dentro do repositório. As respostas oferecem `id`, `node_id`, `repository_url` e `number`; GraphQL oferece `id` e `repository`. **Implicação:** a análise de grafo e de ciclos deve usar identidade qualificada/estável, não somente `#123` nem comparação de títulos. [S01][S03]

### 3.2 Cross-repo, cross-org e planos: o que está e não está provado

- Dependências estão disponíveis nos planos Free, Pro, Team e Enterprise Cloud segundo o front matter oficial; sua criação exige pelo menos triage no repositório. O anúncio de GA especifica até 50 issues por tipo de relação. Isso não determina as permissões de leitura de uma instalação específica. [S02][S04]
- O endpoint recebe o repositório da issue consultada e um `issue_id` da outra issue ao criar a relação; a documentação de CLI aceita números **ou URLs**. São superfícies compatíveis com endereçamento além de um único número local. **Limite:** nem o schema nem a página de uso consultados enunciam uma matriz completa de pares de owners/organizações e visibilidades admitidos pelo backend. IDs globais/URLs não provam que todo par cross-repo seja aceito. [S01][S04][S14]
- **Não foi localizada nas fontes consultadas uma garantia normativa suficiente de cross-org arbitrário**, nem um contrato dizendo que toda dependência inacessível aparece como placeholder/erro. Portanto este relatório não afirma “somente mesma organização”, tampouco “qualquer organização”. É uma lacuna documental a resolver com prova autorizada/suporte oficial antes de aceitar cada combinação de repositórios-alvo. [S01][S03][S04]
- Acesso a todos os repositórios de trabalho não implica acesso a todos os bloqueadores externos. IAT alcança somente repositórios concedidos à instalação e ao token; fine-grained PAT tem um único resource owner. Mesmo que uma relação cross-owner seja aceita pelo produto, a leitura e a estratégia de múltiplas instalações/tokens continuam problemas separados. Nenhuma dessas estratégias está aprovada aqui. [S17][S18][S19]

### 3.3 Significado de consulta completa

**Fato:** REST usa paginação por links/campos de página; GraphQL usa conexões e cursores, com limite de 1–100 itens por solicitação paginada. Uma lista parcial não é uma afirmação de ausência. Falha em página posterior não permite aceitar o prefixo já obtido como completo. [S21][S28]

**Implicação para RF-02:** registrar a identidade consultada, escopo de acesso, páginas percorridas e instante; obter todas as relações acessíveis e consultar o estado de cada destino. Em GraphQL, HTTP 200 com erro de limite ou respostas com dados parciais também não são sucesso integral. Mudança do grafo durante paginação não tem snapshot transacional documentado: contagem coerente é diagnóstico, não prova de ausência de corridas. Reavaliar antes de iniciar/retomar, conforme o PRD. [S01][S03][S28][S39]

O resumo distingue `blockedBy` de `totalBlockedBy`, este último incluindo fechadas. **Não é seguro usar apenas um contador de bloqueadores abertos:** uma dependência fechada como `not_planned`/`duplicate` ainda não satisfaz a política do PRD. A documentação não garante que fechar uma issue apague a relação; o schema contempla totais abertos e fechados. A fábrica deve avaliar a relação e o motivo de conclusão, não inferir remoção automática. [S01][S03]

**Limite crítico:** enumerar tudo que a credencial consegue ver não prova que não existam arestas que ela não consegue ver. Os contadores não possuem garantia documental de serem um total independente de permissões. Uma divergência pode detectar problema; igualdade não certifica inexistência de informação oculta. A instalação precisa demonstrar acesso suficiente nos repositórios-piloto. Se a prova mostrar omissão silenciosa, será necessário explicitar a limitação ao operador e decidir como cumprir a exigência de bloquear dependência inacessível — não há fallback autorizado para prosa. [S01][S03][S18]

### 3.4 Regras de satisfação frente ao PRD

| Estado observado da dependência | Conclusão admissível para a fábrica |
| --- | --- |
| Trabalho da própria fábrica, PR identificado com merge confirmado | Satisfaz pelo critério do PRD, usando a confirmação do PR, não o fechamento isolado da issue. [S05] |
| Dependência externa `state=closed`, `state_reason=completed` / GraphQL `CLOSED`, `COMPLETED` | Evidência documental de conclusão compatível com RF-02; não prova por si só qualidade/aceite além do marcador GitHub. [S01][S03] |
| `closed + not_planned`, `duplicate`, `null`, motivo desconhecido | Não comprova entrega. `duplicate` é enum próprio no contrato atual; não seguir a issue apontada como duplicata para inventar satisfação. [S01][S03][S23] |
| Aberta/reaberta, destino inacessível, erro de consulta, relação inválida ou ciclo | Não satisfaz. Bloqueio/reavaliação é regra do PRD; o schema fornece o grafo, não uma prova pronta de ausência de ciclos. [S01][S03] |

Fechamento por vínculo de PR depende da base: as palavras-chave de fechamento são interpretadas para PR direcionado à default branch, e o merge nessa branch pode fechar a issue vinculada; fora dela o comportamento não é equivalente. **Implicação:** vínculo por corpo/keyword não substitui o registro de associação Trabalho–Ticket–PR, nem o fechamento da issue substitui confirmação de merge. [S29]

<a id="pr-checks"></a>
## 4. PR, regras, checks obrigatórios e commit atual

### 4.1 Descobrir o que é obrigatório

| Fonte | O que responde | Cuidado |
| --- | --- | --- |
| `GET /repos/{owner}/{repo}/rules/branches/{branch}` | Todas as regras **ativas de rulesets** que se aplicam ao nome da branch, inclusive níveis superiores; a branch nem precisa existir. Leitura via `Metadata: read`. | Não retorna rulesets `evaluate`/`disabled`; não substitui branch protection tradicional. Paginar. [S07][S11][S12][S14] |
| `GET /repos/{owner}/{repo}/rulesets` e `.../rulesets/{id}` | Inventário/detalhes, com `includes_parents` documentado; regra de status contém contexto e integração de origem, além de política strict. | A lista de bypass actors só é devolvida a quem tem escrita no ruleset; ausência desse campo não significa ausência de bypass. [S07][S14] |
| `GET /repos/{owner}/{repo}/branches/{branch}/protection` | Proteção tradicional: required status checks, reviews, restrições etc. | Requer `Administration: read` nas tabelas de permissões. Isso é leitura, não o poder `Administration: write`; ainda é uma concessão que precisa ser decidida. Falha/404 isolado não prova que não haja proteção. [S08][S11][S12] |
| GraphQL `CheckRun.isRequired(pullRequestId/pullRequestNumber)` e `StatusContext.isRequired(...)` | Indica se **aquele resultado existente** é obrigatório para o PR especificado. `Commit.statusCheckRollup` contém checks e statuses. | Não enumera checks exigidos que nunca publicaram resultado; não elimina leitura das regras nem a prova de cobertura de requisitos herdados. [S24][S25] |

Rulesets se acumulam entre si e com branch protection; aplica-se a restrição mais forte. Só uma regra de branch protection tradicional se aplica por vez, enquanto múltiplos rulesets podem aplicar-se juntos. Portanto “a primeira regra que encontrei” ou apenas o rollup dos resultados não determina o conjunto obrigatório. O endpoint de regras de branch devolve regras de rulesets, não um certificado único cobrindo todos os mecanismos legados. [S08][S09]

O schema também contém tipos além de `required_status_checks`, como `workflows` e merge queue; políticas de deployment, review, conversas e outros gates podem bloquear o merge sem serem falha de CI. Se um tipo aplicável não for interpretável, a resposta compatível com RF-09 é indeterminação/bloqueio, não “zero checks exigidos”. Não foi provado aqui um algoritmo universal de equivalência com a caixa de merge da UI para todas as regras GitHub.com. [S07][S10][S14]

### 4.2 Resultados, SHA e significado operacional

**Fatos documentados:**

- REST `GET .../commits/{ref}/check-runs` aceita SHA e requer `Checks: read` para App; o filtro padrão é `latest`. Possui paginação e limite adicional de 1.000 check suites recentes por ref; a própria documentação orienta listar suites e runs de cada suite para ultrapassar esse limite. `head_sha`, `name`, `app`, status e conclusão são dados relevantes. [S10][S11][S14]
- Commit statuses são outra superfície: `GET .../commits/{ref}/status` fornece combinado e statuses, e `GET .../commits/{ref}/statuses` permite listar statuses. O combinado não diz sozinho quais contextos são obrigatórios; a avaliação necessita contexto e, quando configurada, identidade da integração esperada. [S13][S10]
- Checks obrigatórios devem corresponder ao último SHA. Resultados anteriores não satisfazem. GitHub considera `success`, `skipped` e `neutral` resultados bem-sucedidos de checks; um workflow que nem rodou por filtros pode deixar o requisito pendente. Quando há status no merge de teste, é esse commit que precisa passar; sem ele, usa-se o head. [S10]
- Se check e commit status têm o mesmo nome e esse nome é obrigatório, **ambos** precisam passar. A origem esperada pode ser uma App específica. Nome de check sem origem e sem SHA não é chave suficiente. Workflows de Actions de eventos não elegíveis podem reportar resultados que não satisfazem o requisito do PR. [S10]
- Strict exige atualização com a base; loose não. Rulesets também podem exigir workflows e fila de merge, com `merge_group` para checks na fila. Isso não autoriza a fábrica a realizar merge/enfileirar para merge. [S07][S10]

**Implicações para RF-08/RF-09 (não uma escolha de implementação):**

1. Capturar identidade do PR, `head.sha`/`headRefOid`, `base.sha`/`baseRefOid`, base ref e instante da leitura; correlacionar os resultados ao conjunto atual. O merge de teste é um artefato distinto da head/base. [S05][S06][S10]
2. Obter o conjunto de requisitos e depois os resultados correspondentes, inclusive status contexts e resultados de merge de teste aplicáveis. Reconsultar head/base se houver alteração durante a avaliação. Não há leitura atômica documentada entre regras, PR e CI. [S05][S07][S10][S13]
3. Check obrigatório ausente/pendente significa espera, não falha de código. Check opcional com falha ou obrigatório de head anterior não deve disparar reparo automaticamente. Falha de um resultado obrigatório atual pode disparar; `action_required`/aprovação de workflow precisa diagnóstico operacional. [S10][S30]
4. Não confundir aprovação pendente de workflow com defeito de implementação. A documentação de forks exige aprovação por ator autorizado em certas situações; permissão para aprovar workflows não deve ser acrescentada ao worker para “destravar CI”. [S30]
5. Falha ao ler regras, tipo desconhecido, dado parcial ou impossibilidade de provar o SHA relevante impede declarar prontidão. A caixa de merge e `mergeStateStatus` são sinais úteis, mas não substituem o conjunto de evidências e a política própria de reviews dos agentes do PRD. [S06][S07][S10]

<a id="draft-conflito"></a>
## 5. Draft, conflito, identidade e confirmação de merge

### 5.1 Draft e prontidão

REST `POST /repos/{owner}/{repo}/pulls` aceita `head`, `base`, `title`, `body` e `draft`; GraphQL possui `convertPullRequestToDraft` e `markPullRequestReadyForReview`. A UI permite ao autor ou a quem tem escrita mudar o estágio; draft não pode ser merged. “Ready for review” muda o estágio e pode disparar solicitações de review, mas não certifica os reviews Standards/Spec nem os comandos locais do PRD. [S05][S06][S31]

A disponibilidade de drafts é condicionada por plano/visibilidade: a referência REST consultada lista repositórios públicos em Free/Free for organizations/Pro e planos legados por repositório, e públicos/privados em Team e Enterprise Cloud. Não assumir draft disponível em todo privado pessoal/Free/Pro. A prova do piloto precisa incluir o plano concreto; indisponibilidade não permite publicar silenciosamente PR pronto no lugar do draft obrigatório. [S05][S14]

### 5.2 Conflito confirmado versus estado desconhecido

REST documenta `mergeable` triestado: `true`, `false`, `null`. `null` significa cálculo assíncrono; dar tempo e consultar novamente. O `merge_commit_sha` anterior ao merge é o commit de teste, não uma confirmação de entrega. GraphQL distingue explicitamente `MergeableState.CONFLICTING`, `MERGEABLE` e `UNKNOWN`; `mergeStateStatus` acrescenta `BEHIND`, `BLOCKED`, `DIRTY`, `CLEAN`, `UNSTABLE` etc. [S05][S06]

**Implicação:** `CONFLICTING` é sinal explícito de conflito; `UNKNOWN`/REST `null` é indeterminação. Estar atrás da base ou bloqueado por review não equivale a conflito de conteúdo. `mergeable=true` só atesta a possibilidade de merge calculada, não todas as condições da fábrica. Não apoiar contrato durável em valores legados/deprecados de `mergeable_state` ou no estado GraphQL `DRAFT` deprecado; consultar `isDraft` separadamente. Revalidar após mudança da head ou base. [S05][S06]

### 5.3 Identidade e merge

Respostas de PR expõem `id`, `node_id`, `number`, repositório, `user`, `head.repo`, `head.ref`, `head.sha`, `base.repo`, `base.ref`, `base.sha`; GraphQL tem IDs de nó, `headRepository`, refs/OIDs, `isDraft`, `merged`, `mergedAt` e `mergedBy`. Esses atributos permitem conferir associação; nenhum título, marcador no corpo ou branch de nome parecido prova por si só ownership pela fábrica. [S05][S06]

**Implicação:** persistir a associação inequívoca entre Trabalho, Ticket, IDs de repositório/PR, branch de trabalho e base autorizada; conferir head repository, não só `owner:branch`. Autor de commit, autor de PR, ator do push e ator que realizou merge são conceitos diferentes. Mudança humana na branch exige reconhecimento, não adoção ou sobrescrita automática. IDs de usuário/nó são dados de identidade mais fortes para correlação que texto de login isolado; `authorAssociation` não é a lista de operadores autorizados de RF-10. [S05][S06][S20]

Para confirmar entrega, `GET /repos/{owner}/{repo}/pulls/{pull_number}/merge` responde 204 quando merged e 404 quando não; o GET completo do PR fornece `merged`, `merged_at`, `merged_by`. **404 sem antes comprovar acesso/identidade não distingue seguramente PR inexistente/inacessível de não merged**. `state=closed` isolado também inclui fechamento sem merge. O SHA final depende do método: merge commit, squash ou último commit que atualizou a base no rebase. Não inferir merge pelo simples aparecimento de commits parecidos na base nem por `merge_commit_sha` pré-merge. [S05][S14][S34]

<a id="feedback"></a>
## 6. Reviews, comentários, respostas e autorização

| Canal | API/sinais | Uso e limite no MVP |
| --- | --- | --- |
| Review formal | `GET .../pulls/{n}/reviews`: autor, ID, `state`, `commit_id`, `submitted_at`, corpo. Estados incluem `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED`, `PENDING`. | Só review humano autorizado `CHANGES_REQUESTED` é gatilho automático conforme PRD. Reviews pendentes/comentadas/dispensadas não são equivalentes. `reviewDecision` agregado não preserva toda a proveniência. [S06][S32] |
| Conversa geral do PR ou issue | `GET /repos/{owner}/{repo}/issues/{n}/comments`: ID, autor, corpo, timestamps; GET/POST é API de **issue comments**, mesmo no PR. | Canal para perguntas e respostas correlacionadas. Comentário ordinário não é review formal nem comando autorizado por conter texto imperativo. [S20] |
| Comentário inline de review | `GET .../pulls/{n}/comments`: review ID, `commit_id`, `original_commit_id`, path/linhas, `in_reply_to_id`; respostas por `POST .../comments/{id}/replies`. | REST aceita reply a comentário de topo, não reply de reply. Paginar; não confundir esses comentários com issue comments. [S33] |
| Thread GraphQL | `PullRequest.reviewThreads`, `comments`, `isResolved`, `isOutdated`, `resolvedBy` e permissões do viewer. | Permite contextualizar conversa resolvida/desatualizada. `isOutdated` não prova que o pedido semântico foi atendido; `isResolved` não é aprovação de review. Paginar threads **e** comentários. [S06][S28] |

Branch protection pode dispensar aprovações antigas após mudanças e exigir revisão do último push; uma review tem um commit associado e pode ser posteriormente dispensada. **Implicação:** consolidar o feedback ainda relevante no começo do reparo, reconsultando reviews/threads e mudanças posteriores. Não usar “último comentário visto” como sinônimo de “pedido humano atual”, nem descartar automaticamente todo `CHANGES_REQUESTED` antigo só porque a head mudou: a relevância depende do estado atual e da política, a definir na spec. [S08][S32][S06]

Para `ask user`, a API fornece autor/IDs e conteúdo; **não implementa a autorização da Software Factory**. A lista explícita de operadores, identificação da pergunta, gramática de resposta/comando, aceitação de edições e tratamento de respostas concorrentes são contrato da fábrica ainda a decidir. Um corpo pode conter quote, instrução de terceiro ou texto de bot. `authorAssociation`, pertencer à organização ou ter escrito a issue não equivale a estar na allowlist do PRD. Correlacionar identificador estável com pergunta persistida e autor autorizado, preservando ID/versão da resposta aceita. [S20][S32][S33]

`Pull requests: write` habilita criar reviews e não representa uma permissão “só abrir draft”. `Issues: write` permite comentar, mas também operações de issues/labels além do fluxo normal. A limitação de quais ferramentas chamam esses endpoints é adicional às permissões GitHub e não deve ser apresentada como escopo nativo mais fino do token. [S11][S12]

<a id="recuperacao"></a>
## 7. Descoberta após efeitos ambíguos e polling

As APIs consultadas documentam criação/listagem e IDs, mas não uma chave universal de idempotência para criar PR ou issue comment. GraphQL `clientMutationId` é descrito como identificador do cliente, retornado na mutation, **não** como garantia de deduplicação no servidor. Timeout/erro de rede após enviar escrita não prova que ela não ocorreu; repetir indiscriminadamente pode duplicar efeito. [S05][S06][S20][S34]

Os itens abaixo são **possibilidades de reconciliação derivadas das superfícies documentadas**, não um protocolo durável já aprovado:

| Efeito possivelmente concluído | Descoberta disponível | Condição de segurança e lacuna |
| --- | --- | --- |
| Push da branch de trabalho | Ler ref remoto (Git `ls-remote`/fetch ou API de refs) e comparar OID com o esperado/publicado, além do histórico local. [S14][S22] | Se OID é outro, pode haver escrita humana/concorrente: não assumir falha nem sobrescrever. Estado atual da ref não reconstrói sozinho toda sua história. Persistência da intenção/SHAs e fencing local continuam necessários. |
| Criação do PR | `GET .../pulls?state=all&head=OWNER:BRANCH&base=BASE`, percorrendo páginas; confirmar IDs de head/base repo, refs, autoria e correlação do trabalho; depois GET por número/ID. [S05][S06] | Procurar também fechados/merged; evitar search index como única evidência. Zero resultados com erro/permissão parcial não autoriza novo POST. Múltiplos candidatos exigem bloqueio, não escolher o mais recente. |
| Publicação de pergunta/marco | Enumerar issue comments do destino e procurar identificador persistido, conferindo autor/ID/contexto. [S20][S21] | Marcador textual pode ser copiado/editado/removido. Não prova ownership sozinho; guardar ID confirmado e intenção de publicação. Nenhum resultado após listagem não atesta que comentário nunca existiu. |
| Transição draft ↔ ready | GET do mesmo PR, conferir identidade e `draft`/`isDraft`. [S05][S06] | A transição pode ter ocorrido e sido revertida por humano. Reconciliar estado atual; não aplicar toggle cego nem sobrescrever decisão humana. |
| Merge humano | GET do PR conhecido + confirmação de merge; preservar método/SHA/ator/instante disponíveis. [S05][S06] | Operação de merge não deve ser reenviada pela fábrica. Fechamento sem merge não satisfaz RF-14. |
| Cancelamento durante publicação | Consultar o efeito já enviado usando os mesmos mecanismos. [S05][S20] | Cancelamento local não desfaz pedido já aceito remotamente. Registrar resultado efetivo sem apagar artefatos/PR por inferência. |

GitHub recomenda evitar polling quando possível, mas o PRD escolhe polling sem webhooks. A API suporta requisições condicionais com `ETag`/`If-None-Match` ou `Last-Modified`/`If-Modified-Since`; 304 em requisição autorizada não conta no limite primário. Cache é por recurso/representação/identidade: 304 de uma página não prova atualização de todas as outras. As recomendações incluem serializar pedidos mutantes, esperar entre escritas e tratar limites secundários. [S34][S35]

Limites primários usuais documentados: não autenticado 60/h por IP; autenticado de usuário 5.000/h; IAT em geral pelo menos 5.000/h, com escala/limites distintos para instalações em Enterprise Cloud. Limites secundários existem além disso e podem mudar; seguir `Retry-After`, `x-ratelimit-remaining` e `x-ratelimit-reset`, com espera progressiva, sem polling agressivo. Uma cadência de 60 segundos por trabalho multiplicada por PRs, páginas e vários endpoints pode exceder orçamento. Falha/limite não é ausência de eventos, e espera de CI/review não precisa consumir slot. [S35][S34]

<a id="credenciais"></a>
## 8. Credenciais: capacidades sem escolher a solução

### 8.1 App installation token versus fine-grained PAT

| Dimensão | GitHub App installation access token (IAT) | Fine-grained PAT |
| --- | --- | --- |
| Principal/autoridade | Age como instalação da App, independente de pessoa. Sucesso depende das permissões da App; não confundir com **user access token de App**, que também depende do usuário. [S18][S19][S36] | Age em nome do usuário, limitado à interseção dos acessos do usuário com escopo do token. Perda do acesso do usuário afeta automação. [S17] |
| Repositórios/owners | Instalação em conta/organização com repositórios selecionados; token pode reduzir para `repositories`/`repository_ids` e permissões concedidas; não ampliar além da instalação. Emissão aceita até 500 repositórios. Instalações distintas não viram um token global. [S18][S19] | Um usuário ou organização como resource owner; seleção de repositórios e permissões. Documentação lista lacunas para múltiplas organizações, outside collaborators e contribuições em públicos onde não é membro. [S17] |
| Vida útil/segredo emissor | Expira em uma hora; obtenção depende de JWT assinado com chave da App. Entregar chave privada/JWT emissor tem impacto maior que entregar IAT reduzido. Formato de instalação mudou em rollout de 2026: não supor comprimento fixo de 40 caracteres. [S19] | Expiração configurável e sujeita a políticas da organização; pode exigir aprovação do owner, ficando pendente/restrito a leitura pública. Não presumir token aprovado ou sem expiração. [S17] |
| Git e API | REST/GraphQL e Git via HTTPS, com `Contents` para conteúdo. A App deve estar instalada no repositório; credencial HTTPS não é a chave SSH pessoal do operador. [S18][S36] | Serve para API/HTTPS em lugar de senha; não altera identidade nem bypasses do usuário. [S17] |
| Dependências, PRs e comentários | Tabelas documentam leitura de dependências e escrita de PR/comentários com as permissões de repositório apropriadas. [S11] | Tabela documenta os mesmos endpoints de dependências/PRs/comentários nas permissões apropriadas, sujeitos às limitações do usuário/owner. [S12][S17] |
| Checks | `Checks: read` para runs/suites documentado. Escrita de Checks API é específica de Apps e não é necessária ao observador da fábrica. [S11][S37] | **Lacuna explícita atual:** página de PAT lista “Using fine-grained personal access token to call the Checks API” entre funcionalidades não suportadas; a tabela PAT consultada não lista check-runs. [S12][S17] |
| Auditoria e bypass | Principal App pode ser incluído ou excluído de bypasses como `Integration`. Uma IAT com escopo reduzido não remove bypass concedido à App. [S14][S15][S19] | Bypasses de usuário/roles/teams continuam relevantes; token restrito não cria automaticamente uma identidade com menos bypass que seu dono. [S09][S14][S17] |

**Divergência a não ocultar:** a visão geral de check-runs diz que usuários autenticados podem visualizar checks, mas a página de PAT distingue a limitação específica de fine-grained PAT. Não extrapolar a frase geral para declarar suporte deste tipo de token. GraphQL oferece `statusCheckRollup`/`isRequired`, porém as fontes consultadas não provam que, com fine-grained PAT, cubra todas as mesmas regras e dados em todos os repositórios. Uma eventual alternativa GraphQL precisaria prova própria; não é fallback validado. PAT classic não foi autorizado como substituição e tem escopo mais amplo. [S17][S24][S25][S37]

### 8.2 Permissões necessárias por superfície, não um conjunto aprovado

| Operação possível do MVP | Permissão documental relevante | Poder adicional/atenção |
| --- | --- | --- |
| Ler ticket, relações nativas e issue comments | `Issues: read` (comments de PR também podem usar `Pull requests: read`). [S11][S12] | Não exige alteração de labels/status. |
| Criar pergunta em issue | `Issues: write`. [S11][S12] | Token ganha outras mutações de issues; contrato de ferramenta não é escopo server-side por endpoint. |
| Ler/criar PR, reviews e comentários de PR | `Pull requests: read/write` conforme endpoint; comments gerais admitem `Issues` ou `Pull requests`. [S11][S12] | Escrita também permite reviews; não aprovar em nome humano. Validar permissões GraphQL de draft/ready na prova. |
| Push em branch de trabalho e operações de refs | `Contents: write`; arquivos de workflow podem exigir também `Workflows: write` conforme operação. [S11][S12][S18][S36] | Não é permissão por branch; também habilita merge. Alterar workflows pode ampliar efeitos via Actions e segredos do repo: escopo e necessidade são decisão pendente. |
| Ler check-runs/suites | App `Checks: read`. [S11][S37] | Não conceder `Checks: write` apenas para observar CI; risco de fabricação de resultados. |
| Ler commit statuses | `Commit statuses: read`. [S11][S12][S13] | Não conceder escrita sem necessidade, especialmente se os checks aceitarem “any source”. |
| Descobrir rulesets ativos/detalhes públicos ao leitor | `Metadata: read`. [S07][S11][S12] | Pode não revelar bypass actors. |
| Ler branch protection tradicional | `Administration: read`. [S08][S11][S12] | Não é administração de escrita; obter essa visibilidade ou evidência por outra superfície continua decisão/prova necessária. |
| Merge síncrono `PUT .../pulls/{n}/merge` e assíncrono `PUT .../pulls/{n}/merge-async` | **`Contents: write`**, para IAT/UAT e fine-grained PAT. [S11][S12][S14] | Não há permissão independente “permitir push mas retirar merge” nessas tabelas. Não basta negar a ferramenta `/merge`. |

<a id="impedir-base"></a>
## 9. Impedir realmente merge e push na base, permitindo trabalho

### 9.1 O que não é uma barreira suficiente

- Prompt “não faça merge”, ausência de comando de merge na CLI ou entrega apenas de Git CLI **não** reduz o escopo server-side de `Contents: write`: o detentor do token ainda pode chamar a API de merge ou tentar atualizar a base por Git/refs/conteúdo. [S11][S12][S14]
- Exigir PR, checks e reviews só impede mudanças que não atendam esses gates. Quando satisfeitos, um ator com permissão pode realizar merge; a documentação chega a permitir merge local seguido de push de PR atualizado/validado. Portanto não constitui, sozinho, proibição permanente de merge pela automação. [S08][S10]
- `Block force pushes` não impede fast-forward nem merge normal. `--force-with-lease` é uma precondição de atualização, não um escopo de autorização; não torna seguro dar poder sobre a base. [S07][S22]
- Bypass “For pull requests only” obriga PR, mas a própria documentação-fonte diz que o ator pode contornar proteções e **fazer merge**. Bypass concedido a `write`/`maintain`, team amplo ou App precisa ser considerado, mesmo que o token não tenha `Administration: write`. [S15][S16][S14]

### 9.2 Mecanismos documentados que podem compor a separação

**Possibilidade A — ruleset de branch com `Restrict updates` na base.** A regra permite atualização das refs alvo somente por atores com bypass. O padrão/condição deve atingir a base autorizada (inclusive mudanças de default branch/nome a considerar) e não a branch de trabalho. A automação não pode estar no bypass, direta ou indiretamente por role/team/App; humanos de merge precisam de caminho autorizado. Como merge atualiza a base, a combinação é candidata a impedir merge API/Git dessa identidade enquanto permite push de trabalho. **Isso é uma implicação do modelo de atualização, ainda exige prova negativa contra cada caminho de escrita**, não uma validação já obtida. [S07][S09][S14][S15]

Um bypass dispensa as regras daquele ruleset. Assim, se o mesmo ruleset contiver também checks/reviews e os humanos receberem bypass para conseguir atualizar, a composição pode permitir que esses humanos dispensem gates. Rulesets separados/acumulados podem preservar exigências, mas a configuração exata pertence ao operador: é necessário provar tanto “automação negada” quanto “humano só com o fluxo/gates aprovados”. A presente pesquisa não autoriza criar/alterar regras. O schema tem ainda `update_allows_fetch_and_merge`, exceção de pull do upstream a conferir em forks; não ignorar parâmetros ao auditar a regra. [S07][S09][S14][S16]

**Possibilidade B — branch protection tradicional com `Restrict who can push`.** Disponível em repositórios públicos de organização Free e nos repositórios de organizações Team/Enterprise Cloud; não é uma capacidade universal de repositórios pessoais. Só users/teams/Apps autorizados podem fazer push; mesmo eles continuam sujeitos a checks/PR quando exigidos. Administradores e roles de bypass são exceções por padrão; a opção de não permitir bypass também precisa ser auditada. Não basta constatar que a branch está marcada como protected. [S08]

**Possibilidade C — não expor ao worker credencial GitHub com escrita direta.** Um intermediário que valide destino/ref/operação poderia publicar em nome do trabalho e não oferecer operação de base/merge. Isso é alternativa conceitual frente à impossibilidade de separar só por escopo do token, **não uma recomendação aprovada de concentrar poderes no controlador**. Sua superfície, credenciais e fronteira são decisão HITL reservada na cartografia; este relatório não as define. [S11][S12][S14]

### 9.3 Plano, enforcement e prova de configuração

Rulesets de branch/tag são documentados em públicos Free/Free for organizations e públicos/privados Pro, Team e Enterprise Cloud. Rulesets de **push** são outro mecanismo: restringem conteúdo/tamanho/caminho de arquivos em toda a rede de forks, não selecionam branches e não substituem a separação da base. Sua disponibilidade de planos/privados/internal difere. A documentação de criação de rulesets de organização cita Team/Enterprise, enquanto trechos do overview destacam Enterprise para organização; confirmar a capacidade exata no plano e no nível selecionados, sem inferir autorização de uma menção genérica. [S09][S27][S38]

Só ruleset **Active** impõe restrição. `Evaluate` e `Disabled` não são barreira; o endpoint de regras ativas exclui ambos. Rulesets se acumulam e proteções tradicionais também se aplicam. O detalhe de regras pode ocultar `bypass_actors` para leitores sem escrita no ruleset: por isso uma auditoria somente com a credencial restrita da fábrica pode não provar exclusão de bypass. É necessário obter evidência administrativa do operador sem conceder escrita administrativa ao worker. [S07][S09][S14]

**Conclusão delimitada:** existe mecanismo nativo documentado para limitar atualização por ator/ref, mas a garantia RNF-02 não nasce de “usar App” nem de “usar PAT”. Ela depende da identidade concreta, regras ativas, padrões de ref, bypasses, permissões do plano e caminhos alternativos. Sem controle aplicável ou intermediação aprovada, `Contents: write` exposto ao worker não satisfaz por si só “sem poderes de merge/push base”. A credencial do próprio operador com bypass é especialmente incompatível com presumir essa separação. [S11][S12][S14][S17]

<a id="lease"></a>
## 10. Rebase, force-with-lease e concorrência

O manual oficial documenta `--force-with-lease=<refname>:<expect>` como atualização apenas se o valor remoto ainda é exatamente `<expect>`. As formas sem expectativa explícita dependem de remote-tracking refs; fetch em background pode atualizar essas refs e destruir a proteção pretendida. O manual ressalva como experimentais as formas que não especificam explicitamente o valor esperado. [S22]

**Implicação para RF-09/CA-09:** capturar o OID remoto esperado antes da operação e preservar qual histórico foi considerado; usar refspec explícito somente da branch do trabalho. Exemplo de forma, **não executado** e sem autorização de rebase/publicação de código nesta pesquisa:

```text
git push --force-with-lease=refs/heads/BRANCH_TRABALHO:OID_ESPERADO \
  origin COMMIT_LOCAL:refs/heads/BRANCH_TRABALHO
```

A opção não concede privilégio contra regra que proíba non-fast-forward e não diferencia, no servidor, “reescrita autorizada após rebase” de “reescrita arbitrária com o OID correto”. Para permitir rebase publicado, a branch de trabalho precisa admitir essa atualização sob as políticas vigentes. Liberar force push no trabalho não deve liberar na base; não conceder bypass amplo só para resolver essa incompatibilidade. Falha do lease exige preservar artefatos/reportar concorrência, nunca recapturar a expectativa e insistir às cegas. [S07][S08][S22]

Um lease bem-sucedido protege contra alteração do valor da ref desde a expectativa; não prova ausência de mudanças humanas anteriores ao OID capturado, nem coordena processos/worktrees locais, nem fornece fencing de builder. Esses requisitos permanecem no modelo local da fábrica. Após timeout de push, descobrir o OID remoto antes de decidir repetir. [S22]

<a id="matriz-requisitos"></a>
## 11. Matriz de cobertura por requisito

“Documentado” não significa aceite demonstrado. Esta matriz cobre a parte GitHub; não substitui a cobertura integral de runtime, armazenamento, isolamento ou UI da fábrica.

| Requisito / aceite | Capacidade ou limitação encontrada | Evidência e prova necessária |
| --- | --- | --- |
| RF-01; CA-10 | Issues/labels/IDs permitem consultar elegibilidade; deduplicação de Trabalho e reconhecimento de PR próprio não são garantias GitHub. | [S01][S05]; [P01/P07](#provas-necessarias). |
| RF-02; CA-02 | Relações nativas, paginação, motivos de fechamento e totais. Cross-org e ocultação por acesso não demonstrados. | [S01]–[S04]; P01–P03. |
| RF-03; CA-03/04 | Consultas/paginação permitem obter entradas; filas, slots, FIFO e consolidação são locais, não capacidades do tracker. | [S05][S21]; P07/P08 para efeitos e eventos repetidos. |
| RF-04; CA-03/06 | IDs de ref/PR e lease ajudam reconhecer alterações. Não há fencing de escritor local por essas APIs. | [S05][S22]; P07/P10. |
| RF-05; CA-01 | IDs, timestamps, bodies e SHAs podem registrar a versão lida; GitHub não impede incorporação silenciosa de escopo pelo agente. | [S01][S05][S20]; P01/P08 (edições). |
| RF-06; CA-01/12 | Reviews GitHub não são os dois revisores internos do PRD; sua conclusão/invalidação precisa registro próprio e correlação ao conteúdo. | [S06][S32]; P04/P08, além de provas de runtime fora desta pesquisa. |
| RF-07; CA-12 | Checks/statuses e regras podem evidenciar gates remotos; não atestam testes locais não executados. Dispensa não elimina requisito GitHub. | [S07][S10][S13]; P04. |
| RF-08; CA-01/06 | Criar draft, consultar identidade e converter ready são documentados, com restrições de plano. Descoberta após POST não é exactly-once. | [S05][S06][S31]; P05/P07. |
| RF-09; CA-04/09 | Mergeability triestado, regras herdadas, checks por SHA, reviews e lease explícito. Não existe “verde universal” comprovado por uma chamada. | [S06]–[S10][S22][S24][S25]; P04/P06/P08/P10. |
| RF-10; CA-05 | Comentários e replies possuem IDs/autoria; autorização/correlação das respostas são contrato da fábrica. | [S20][S32][S33]; P08. |
| RF-11; CA-10 | Closed versus merged são distintos; palavras-chave de fechamento dependem da default branch. Reabrir/relabel não deduplica trabalho automaticamente. | [S05][S29]; P01/P05/P07. |
| RF-12; CA-07 | Cancelar localmente não desfaz mutação enviada; resultado precisa descoberta. | [S05][S20]; P07. |
| RF-13; CA-07/11 | Rate limits e falhas transitórias existem; limites de correção/retomada são política local. Erro de autorização não é CI falhando. | [S34][S35][S36]; P04/P12. |
| RF-14; CA-01/07 | Merge confirmado é observável, mas exclusão de branch exige checar identidade/propriedade e base; cleanup conservador não é automático pela API. | [S05][S14]; P05/P07/P09. |
| RNF-01; CA-06 | APIs de descoberta suportam reconciliação, sem transação com armazenamento local ou chave universal de idempotência. | [S05][S06][S20][S22]; P07. |
| RNF-02; CA-09 | Permissão de conteúdo mistura push/merge. Contenção real depende de regras/identidade ou fronteira aprovada; Docker/host fora do escopo. | [S11]–[S19][S22]; P09–P11. |
| RNF-03; CA-12 | IDs, SHAs, autoria e estados permitem auditoria; histórico lógico, perguntas e decisões precisam persistência própria. | [S05][S20][S32]; P07/P08. |
| RNF-04 | Paginação, conditional requests e limites suportam polling disciplinado; não prometem detecção instantânea nem snapshot consistente. | [S21][S28][S34][S35]; P12. |
| RNF-05 | GitHub aplica regras no servidor quando configuradas; política previsível da fábrica e ferramentas restritas não surgem do modelo/token. | [S07][S09][S11][S12]; P09/P11. |

<a id="provas-necessarias"></a>
## 12. Provas necessárias antes de declarar compatibilidade/aceite

**Não executadas nesta pesquisa.** Requerem autorização própria para recursos descartáveis, credenciais e mudanças de configuração. Não usar produção nem conceder poderes adicionais silenciosamente. Capturar plano, owner, visibilidade, versão REST, queries GraphQL, IDs/SHAs, permissões efetivas, regras e respostas sanitizadas, sem segredos. Casos negativos devem ser tentativas efetivas negadas pelo servidor, não apenas ausência de botão na UI.

| ID | Prova proposta | Evidência exigida / critério |
| --- | --- | --- |
| P01 | Dependências no mesmo repo, paginação além do default, relações fechadas/reabertas, `completed`/`not_planned`/`duplicate`/sem motivo; ciclo. | Lista completa REST/GraphQL e totais, preservação da relação após fechar/reabrir, liberação apenas conforme RF-02; polling repetido não duplica Trabalho. |
| P02 | Matriz de pares: mesmo owner cross-repo público/privado, privado/privado, organizações distintas, organização↔conta pessoal; ambos os sentidos e credenciais de leitura selecionadas. | Aceitação/erro documentado pelo serviço para cada par, não inferência de UI. Registrar quem consegue criar e quem consegue ler. Combinação não suportada deve ser explicitamente bloqueada. |
| P03 | Reduzir/remover acesso a um repo bloqueador depois de criar relação; listar com e sem acesso. | Saber se ocorre 403/404, omissão, null ou contador divergente; demonstrar que ausência aparente não libera indevidamente. Se ocultação for indetectável, registrar limitação e devolver decisão ao operador. |
| P04 | CI em head atual/antiga e merge de teste; checks/statuses com mesmo nome, App de origem, requisito sem resultado, opcional falhando, skipped/neutral, workflow não disparado/aguardando aprovação, regras tradicionais + repo/org. | Conjunto obrigatório completo e SHA correto; somente falha obrigatória atual dispara reparo; pendência espera, aprovação operacional bloqueia. Comparar UI com consultas. Cobrir rulesets `workflows`/merge queue se presentes, sem merge pela fábrica. |
| P05 | Criar draft e converter ready no plano piloto; fechar sem merge; merge humano por merge/squash/rebase; base não default. | Disponibilidade/permissões de draft; IDs/ref corretos; distinção closed/merged, SHA pós-merge e fechamento de issue; nenhuma entrega inferida de keyword. |
| P06 | Consultar logo após push/base alterada, observar estado desconhecido e conflito verdadeiro, depois resolução. | `null`/`UNKNOWN` nunca aciona conflito confirmado/prontidão; correlação ao head/base atuais e reconsulta conservadora. |
| P07 | Cortar resposta depois de push, criação de PR, comentário de pergunta e transição ready; reiniciar; cancelar durante pedido. | Recuperar efeito sem criar segundo PR/pergunta, inclusive PR já fechado; candidatos múltiplos/ausência com erro bloqueiam; registrar efeito concluído durante cancelamento. Não demonstra fencing de processos sozinho. |
| P08 | Reviews humanos autorizados/não autorizados, bot, `CHANGES_REQUESTED` antigo/dispensado, thread resolvida/outdated; reply inline; comentário geral; resposta editada/copias/duas respostas. | Não confundir canais nem autoridade; consolidar feedback relevante; uma resposta válida à pergunta certa; comentários comuns não disparam reparo. |
| P09 | Com a identidade/credencial candidata e regras reais: push e force-push base, update/delete/create ref, Contents API, merge REST síncrono/assíncrono e GraphQL, auto-merge/enqueue onde aplicável; push trabalho positivo. | Todos os caminhos de base/merge negados mesmo com PR aprovado/checks verdes; criação/push trabalho permitidos; base inalterada; humano mantém caminho de merge aprovado. Registrar bypasses inclusive indiretos e campo oculto ao leitor. |
| P10 | Capturar OID trabalho; avançar remoto humanamente; tentar rebase push com lease explícito antigo; repetir cenário com fetch em background; branch-base protegida. | Lease falha sem sobrescrever remoto; sem recaptura automática; refspec somente trabalho; branch de trabalho pode aceitar reescrita legítima sem bypass amplo da base. |
| P11 | Comparar IAT reduzida e fine-grained PAT nos endpoints necessários, GraphQL de draft/checks/regras, escopo de repo/owner, política de aprovação e expiração. | Confirmar ou refutar limitações de Checks API/GraphQL com PAT; impedir acesso fora do repo; expiração visível; provar que bypass do principal não foi esquecido. Não escolher credencial só por sucesso de clone/push. |
| P12 | Simular orçamento de polling a 60 s com múltiplos trabalhos/páginas; ETag/304, falha em página posterior, 403/429, Retry-After, token expirado, regra desconhecida/dado parcial. | Backoff e bloqueio distinguíveis de “sem novidades/verde”; sem loops de escrita; métricas do custo de chamadas; recuperação sem aceitar prefixos incompletos. |

<a id="lacunas-decisoes"></a>
## 13. Lacunas e decisões reservadas ao operador

1. **Escopo de dependências suportado:** falta evidência normativa/experimental suficiente para combinações cross-org e visibilidade de arestas inacessíveis (P02/P03). O PRD exige explicitar esse limite, não emular dependências via Markdown.
2. **Credencial e principal:** IAT versus PAT, conta/instalação, repositórios/owners atendidos, ciclo de expiração e emissor não escolhidos. A documentação registra limitações relevantes de PAT; a decisão deve considerar as provas P09/P11, não só conveniência.
3. **Fronteira de autoridade:** quem recebe credencial de conteúdo, quem emite tokens e quem publica é decisão HITL já reservada pela cartografia. A alternativa de intermediação não foi aprovada nesta pesquisa.
4. **Políticas/plano dos pilotos:** falta inventário concreto de base, visibilidade, plano, regras herdadas/tradicionais, bypasses e eventuais workflows com poderes próprios. Sem isso não há prova de RNF-02 ou da descoberta completa de checks.
5. **Semântica de feedback e recuperação:** relevância após novos commits, respostas editadas/concorrentes e ownership durável precisam contrato próprio; as APIs fornecem dados, não a política. O caso de nenhuma evidência remanescente após exclusão externa não possui descoberta infalível demonstrada.
6. **Ameaças fora da evidência:** este relatório não prova sandbox, proteção de chave/token no host, contenção de Docker, segurança de workflows/secrets nem proteção contra administrador que altera regras. Proibir merge direto da identidade worker não impede, por si, efeitos privilegiados de workflows disparados por seu push.

O resultado é um levantamento de capacidades, limites e provas, **não uma autorização para instalar App, criar PAT, alterar rulesets, ampliar permissões, realizar merge ou implementar a fábrica**. Follow-up fica documentado aqui; mapa e ticket não foram alterados pelo pesquisador.

<a id="fontes-e-versoes"></a>
## 14. Fontes e versões

Todas consultadas em **2026-11-03 UTC**, fontes primárias. A obtenção foi por HTTPS público (`curl`/biblioteca padrão Python), incluindo texto de artigos do próprio `docs.github.com/api/article/body`; não foi necessário instalar/habilitar ferramentas externas. O endpoint de corpo omite alguns banners de disponibilidade, por isso também foram lidos os arquivos-fonte fixados abaixo. Requisições a documentação e aos repositórios públicos de fonte não utilizaram autenticação. URLs de tentativa que retornaram erro não são fundamento para as conclusões.

- **S01 — REST, issue dependencies:** operações `blocked_by` e `blocking`, paginação e schema de Issue. [Documento][S01].
- **S02 — Changelog GA (2025-08-21):** disponibilidade geral e máximo de 50 relações de cada tipo. [Anúncio][S02].
- **S03 — GraphQL, Issues:** `Issue`, `IssueConnection`, `IssueDependenciesSummary`, `IssueStateReason`. [Referência][S03].
- **S04 — Fonte da página de dependências, fixada:** planos/permissões e uso por CLI. [Arquivo][S04].
- **S05 — REST, Pull requests:** listar/criar/consultar, draft, mergeability, merged e APIs de merge. [Referência][S05].
- **S06 — GraphQL, Pull requests:** `PullRequest`, mutations draft/ready, mergeability, reviews e threads. [Referência][S06].
- **S07 — REST, repository rules:** regras ativas da branch, listagem/detalhes de rulesets. [Referência][S07].
- **S08 — Protected branches:** regras tradicionais, restrições de push, bypass, reviews e force pushes. [Guia][S08].
- **S09 — About rulesets:** acúmulo/enforcement e comparação com proteção tradicional. [Guia][S09].
- **S10 — Troubleshooting required status checks:** SHA atual, merge de teste, skipped/neutral, fontes e eventos de workflow. [Guia][S10].
- **S11 — Permissões de GitHub Apps:** tabela endpoint × permissão × IAT/UAT. [Tabela][S11].
- **S12 — Permissões de fine-grained PAT:** tabela endpoint × permissão. [Tabela][S12].
- **S13 — REST, commit statuses:** combinado e listagem de statuses. [Referência][S13].
- **S14 — OpenAPI GitHub.com, fixado:** schemas/rotas REST no commit indicado, incluindo merge-async, update rules e bypass actors. [Schema][S14].
- **S15 — Fonte de bypass de ruleset, fixada:** atores elegíveis, inclusive roles e Apps. [Arquivo][S15].
- **S16 — Fonte de bypass “PR only”, fixada:** permite contornar regras e fazer merge. [Arquivo][S16].
- **S17 — Managing personal access tokens:** identidade, limites por owner, limitações Checks API, aprovação/expiração. [Guia][S17].
- **S18 — Authenticating as an App installation:** escopo, Git HTTPS, REST/GraphQL. [Guia][S18].
- **S19 — Generating installation access token:** redução de repositórios/permissões, 500 repos, uma hora, formato novo em 2026. [Guia][S19].
- **S20 — REST, issue comments:** listar/criar/editar, autor e timestamps; comentários gerais de PR. [Referência][S20].
- **S21 — REST pagination:** links/páginas e limites. [Guia][S21].
- **S22 — Git, git-push, fonte fixada:** lease explícito, refspec e riscos de fetch em background. [Manual-fonte][S22].
- **S23 — API versions:** versões suportadas/default, mudanças aditivas e enum values. [Guia][S23].
- **S24 — GraphQL, Checks:** `CheckRun.isRequired` e estados. [Referência][S24].
- **S25 — GraphQL, Commits:** `Commit.statusCheckRollup`, `StatusContext.isRequired`, rollup/contexts. [Referência][S25].
- **S26 — Forming GraphQL calls:** autenticação e respostas, inclusive erros. [Guia][S26].
- **S27 — Fonte de disponibilidade de repo rules, fixada:** planos/visibilidade de branch/tag e push rulesets. [Arquivo][S27].
- **S28 — GraphQL pagination:** conexões/cursor e limites 1–100. [Guia][S28].
- **S29 — Linking a PR to an issue:** fechamento por palavras-chave/default branch. [Guia][S29].
- **S30 — Approving workflow runs from public forks:** aprovação operacional por humano autorizado. [Guia][S30].
- **S31 — Changing the stage of a PR:** draft/ready e permissões. [Guia][S31].
- **S32 — REST, pull request reviews:** estados, IDs e commit da review. [Referência][S32].
- **S33 — REST, review comments:** inline/replies e limite de resposta a topo. [Referência][S33].
- **S34 — REST best practices:** conditional requests, prevenção de rate limiting e tratamento de falhas. [Guia][S34].
- **S35 — REST rate limits:** primários/secundários e headers. [Guia][S35].
- **S36 — Choosing App permissions:** interseção UAT versus IAT, REST/GraphQL e Git. [Guia][S36].
- **S37 — REST, check runs:** leitura, escrita específica de Apps, filtros e limite de suites. [Referência][S37].
- **S38 — Organization rulesets:** criação, nível organizacional e plano. [Guia][S38].
- **S39 — GraphQL resource limitations:** HTTP 200 com erros de rate limit, limites de recursos e dados parciais. [Guia][S39].

[S01]: https://docs.github.com/en/rest/issues/issue-dependencies
[S02]: https://github.blog/changelog/2025-08-21-dependencies-on-issues/
[S03]: https://docs.github.com/en/graphql/reference/issues
[S04]: https://github.com/github/docs/blob/7fa55a0ac28d01b5cb6f9cbebff06fbee1e2408f/content/issues/tracking-your-work-with-issues/using-issues/creating-issue-dependencies.md
[S05]: https://docs.github.com/en/rest/pulls/pulls
[S06]: https://docs.github.com/en/graphql/reference/pulls
[S07]: https://docs.github.com/en/rest/repos/rules
[S08]: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches
[S09]: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets
[S10]: https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks
[S11]: https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps
[S12]: https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens
[S13]: https://docs.github.com/en/rest/commits/statuses
[S14]: https://github.com/github/rest-api-description/blob/6348fd455a44a445f9e37a505e981b2c3ed24046/descriptions/api.github.com/api.github.com.json
[S15]: https://github.com/github/docs/blob/7fa55a0ac28d01b5cb6f9cbebff06fbee1e2408f/data/reusables/repositories/rulesets-bypass-step.md
[S16]: https://github.com/github/docs/blob/7fa55a0ac28d01b5cb6f9cbebff06fbee1e2408f/data/reusables/repositories/rulesets-branch-tag-bypass-optional-step.md
[S17]: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens
[S18]: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation
[S19]: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app
[S20]: https://docs.github.com/en/rest/issues/comments
[S21]: https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api
[S22]: https://github.com/git/git/blob/ebdc087dc99d68bb340c282b2ba5f722def28d19/Documentation/git-push.adoc
[S23]: https://docs.github.com/en/rest/about-the-rest-api/api-versions
[S24]: https://docs.github.com/en/graphql/reference/checks
[S25]: https://docs.github.com/en/graphql/reference/commits
[S26]: https://docs.github.com/en/graphql/guides/forming-calls-with-graphql
[S27]: https://github.com/github/docs/blob/7fa55a0ac28d01b5cb6f9cbebff06fbee1e2408f/data/reusables/gated-features/repo-rules.md
[S28]: https://docs.github.com/en/graphql/guides/using-pagination-in-the-graphql-api
[S29]: https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue
[S30]: https://docs.github.com/en/actions/how-tos/manage-workflow-runs/approve-runs-from-forks
[S31]: https://docs.github.com/en/pull-requests/how-tos/create-pull-requests/changing-the-stage-of-a-pull-request
[S32]: https://docs.github.com/en/rest/pulls/reviews
[S33]: https://docs.github.com/en/rest/pulls/comments
[S34]: https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api
[S35]: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
[S36]: https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app
[S37]: https://docs.github.com/en/rest/checks/runs
[S38]: https://docs.github.com/en/organizations/managing-organization-settings/creating-rulesets-for-repositories-in-your-organization
[S39]: https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api

## 15. Validações documentais do artefato

- 39 referências definidas e citadas, sem identificadores de fonte indefinidos; todos os links externos chegaram a HTTP 200 na consulta, acompanhando redirects oficiais e preferindo os destinos atuais na lista final.
- Links locais de PRD, mapa e ticket verificados no checkout; âncoras internas explícitas e blocos de código conferidos; 12 provas propostas identificadas. Nenhuma prova autenticada P01–P12 foi executada.
- Os seis arquivos-fonte fixados (S04, S14, S15, S16, S22 e S27) foram baixados pelo commit e comparados byte a byte com o material consultado: todos idênticos.
- Verificação de whitespace por `git diff --check` e, para cobrir o arquivo novo no índice antes do commit, `git diff --cached --check`. Não há implementação, testes de código ou alteração de mapa/ticket neste artefato.
