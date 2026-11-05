# Definir o escopo suportado e a validação das dependências nativas

Status: resolved
Assignee: Samuel Santos (operador), assistido por Pi
Context: decisão HITL confirmada nesta sessão; branch de registro `wayfinder/software-factory-dependencies`; integração em `main` no checkout `/home/sanmoo/dev/github.com/Sanmoo/pkm`. Worktree de registro: `/home/sanmoo/dev/github.com/Sanmoo/pkm/.worktrees/software-factory-dependencies`; sem publicação de `main`.
Type: grilling
Label: wayfinder:grilling
Map: [Especificar tecnicamente o MVP da Software Factory](../map.md)
Blocked by: 01, 05

## Question

Como a instalação demonstrará que consegue ler e avaliar corretamente as dependências nativas dos repositórios autorizados, sem liberar Trabalho quando uma aresta inacessível pode estar oculta?

Usar [Investigar APIs e permissões GitHub para os controles do MVP](05-github-capabilities.md), especialmente limites de cross-org e completude. A fronteira de autoridade/credenciais fornece o principal que realiza as consultas; não rediscuti-la aqui.

Definir escopo inicial entre repositórios/owners, pré-voo de compatibilidade/permissões, estratégia de enumeração/paginação e reavaliação, detecção de ciclos/destinos inacessíveis, e regras observáveis de bloqueio quando não for possível comprovar leitura suficiente. Preservar a satisfação por merge do Trabalho próprio e por closed+completed da dependência externa, conforme RF-02.

Definir a prova mínima que decide suporte de cada combinação e o tratamento de omissão silenciosa ou limitação do serviço: explicitar incompatibilidade, interromper a admissão afetada e devolver eventual incompatibilidade com o PRD ao humano, nunca fallback para Markdown ou liberação presumida. Não inventar uma garantia inexistente para “resolver” a lacuna.

Saída: política e contrato de compatibilidade decididos com o humano, critérios verificáveis e lacunas/provas futuras. Executar chamadas autenticadas ou criar dependências está fora deste ticket e exige autorização própria.

## References

- [PRD — Software Factory MVP](../prd.md): RF-01–02; RNF-01 e RNF-04; CA-02 e CA-10.
- [Investigar APIs e permissões GitHub para os controles do MVP](05-github-capabilities.md): relatório imutável, capacidades e limites documentais.
- [Definir a fronteira mínima entre controlador e builder](01-control-authority.md): GitHub App e autoridade por operação.
- [Definir estados, filas, persistência e reconciliação dos efeitos](08-state-and-effects-contract.md): índice de ciclos, impedimentos ortogonais e admissão de Execução.

## Comments

- Graduado na revisão da pesquisa GitHub; não é ticket de implementação.
- Aprovações HITL: Q1–Q3, Q5–Q6 e Q8 aprovadas nas respectivas rodadas. Q4 original foi substituída pela comparação solicitada pelo operador; Q4 reformulada (`gh api` + REST) aprovada com “sim”. Q7 e Q9 originais não foram aprovadas; após questionamento da restritividade e explicação dos testes, o operador confirmou “de acordo com as propostas reformuladas”.
- O Answer consolida as decisões finais e a comparação documental. Não permanece como exigência a proposta anterior de certificação manual por par de repositórios ou recertificação geral a cada atualização do CLI.
- Consulta complementar limitada a documentação/código oficiais e ajuda local de `gh 2.98.0 (2026-08-21)`. Nenhuma chamada autenticada, credencial real, alteração de permissões, criação de recursos, instalação, modelo, Builder ou prova operacional foi executada. A pesquisa inicial não foi reaberta.
- Validação documental: `git diff --check`; 22 tickets com status/tipos/labels e Answers consistentes; dependências existentes e sem ciclos; 189 referências locais verificadas; resoluções indexadas e fronteira recalculada. Não são testes de execução do MVP.

## Answer

### Escolha e fronteira de suporte

Usar **GitHub CLI `gh api` com REST**, sob um adapter do controlador, como caminho único para consulta das dependências nativas. O controlador continua decidindo elegibilidade, satisfação, ciclos, bloqueios, polling e disparos; o CLI é cliente de acesso ao GitHub, não autoridade de workflow.

Distinguir repositórios autorizados para execução daqueles acessíveis somente para leitura de dependências. Poder ler um bloqueador não autoriza implementar tickets nele. Preservar a GitHub App já escolhida, sem introduzir outra credencial silenciosamente.

Não impor nem presumir suporte por owner: dependências no mesmo repositório, entre repositórios do mesmo owner ou entre owners diferentes dependem das capacidades reais do GitHub e do acesso da instalação. A validação combina testes dos cenários suportados, pré-voo automático da instalação e avaliação das relações reais em operação. **Não haverá matriz manual de certificação de todos os pares nem aprovação humana por Ticket.**

Uma combinação ainda não coberta pelo suporte demonstrado não é presumida compatível. Isso não exige repetir experimentos para cada par de repositórios que se enquadre em um cenário já suportado: validar o cenário e conferir o acesso efetivo da instalação, em vez de certificar cada par individualmente.

### Cliente, autenticação e alternativas avaliadas

Separar protocolo (REST/GraphQL) de cliente (CLI/HTTP/SDK). Escolher `gh` não obriga usar comandos de alto nível nem autenticação pessoal.

| Alternativa | Avaliação e motivo da escolha |
| --- | --- |
| `gh issue view --json blockedBy,blocking,state,stateReason,...` | Alternativa real, presente na ajuda local e no manual. Na versão 2.98.0, conexões de dependências usam `first:50`, `nodes` e `totalCount`, sem `pageInfo`; destinos contêm identidade, repositório e estado, mas não seu `stateReason`. O limite coincide com as 50 relações documentadas, portanto não prova truncamento hoje. Ainda exige consultas dos destinos e validação do contrato; não fornece sozinho toda a avaliação. |
| `gh api` + REST | Escolhido: reaproveita cliente, token, paginação e JSON com endpoint/método/versão explícitos, sem exigir um cliente HTTP próprio ou SDK GitHub para essas consultas. Custo: distribuir/versionar o binário e supervisionar subprocessos. Não foi feito benchmark. |
| `gh api graphql` | Permite selecionar campos/agregar dados, mas requer queries, cursores e tratamento de erros/dados parciais. `--paginate` para uma conexão não percorre automaticamente todo grafo aninhado. Não será fallback automático. |
| HTTP direto ou SDK, como Octokit | Evita subprocessos e oferece acesso direto a status/headers; SDK pode auxiliar emissão/renovação de tokens. HTTP próprio exige código de integração, SDK adiciona dependência e políticas a configurar. Essas vantagens não demonstraram necessidade de outro cliente para este contrato. |

Contrato do adapter:

- Invocar o executável diretamente com argumentos estruturados, sem shell/pipeline ou interpretação da saída humana.
- Host, repositório, método GET e versão REST devem ser explícitos; fixar/testar a versão suportada. O recorte documental consultado usa `2026-03-10`, sem presumir equivalência com outras versões.
- Usar installation access token fornecido pelo controlador via ambiente controlado, com concessões necessárias de leitura. A chave emissora permanece no controlador. Emissão/renovação continuam sob seu controle, não dependem de login pessoal nem de retry implícito do CLI.
- Configuração do `gh` independente da conta do operador; não herdar credenciais, aliases ou configuração global. Não usar cache temporal para aprovar uma avaliação atual nem debug que exponha credenciais.
- Capturar término, código de saída, payload completo e informação de status/headers necessária ao acompanhamento/rate limit, com proteção de segredos. Término bem-sucedido é necessário, mas não substitui validação do JSON e da identidade/semântica dos dados.
- `--paginate`/`--slurp` podem obter e agregar páginas. O processo pode emitir páginas anteriores antes de uma falha posterior: nenhuma saída parcial é confirmação de consulta completa.
- Não alternar automaticamente para GraphQL, HTTP próprio ou outra identidade quando a consulta falhar.

A escolha vale para leitura de dependências pelo controlador; não escolhe automaticamente transporte de todas as demais operações GitHub da fábrica.

### Enumeração, grafo e satisfação

Consultar exclusivamente `blocked_by` nativo; não interpretar prosa, `Depends on`, labels ou indicação de duplicata como relação substituta. `blocking` é a relação inversa, não substituto da consulta de bloqueadores para elegibilidade.

Percorrer o grafo de bloqueadores alcançável a partir do Ticket, inclusive relações com issues encerradas, sem varrer todos os tickets dos repositórios. Usar identidades GitHub estáveis/qualificadas, não títulos nem número isolado. Visitar cada issue uma vez por avaliação e distinguir nó compartilhado de ciclo no caminho.

Obter todas as páginas de relações e avaliar identidade/estado dos destinos. Página que falha, resposta inválida, relação inválida, destino inacessível, ciclo ou travessia interrompida não liberam execução. Não presumir que encerrar uma issue remove suas arestas. Acessibilidade e validade do grafo são verificações distintas da satisfação dos nós: uma dependência transitiva inacessível impede concluir a avaliação mesmo com intermediário encerrado.

Limites de API podem adiar a conclusão, nunca transformar um prefixo da travessia em aprovação. Contagens coerentes ajudam no diagnóstico, mas não certificam ausência de relações ocultas ou de alterações concorrentes.

| Dependência | Critério de satisfação |
| --- | --- |
| Ticket conhecido no índice da fábrica | Avaliar Trabalho vigente ou, na ausência dele, último ciclo registrado. Requer merge confirmado do PR desse Trabalho. |
| Trabalho aberto, cancelado ou com PR fechado sem merge | Não satisfaz; `closed + completed` da issue não substitui entrega própria. |
| Novo ciclo próprio aberto explicitamente após entrega anterior | Merge do ciclo antigo não satisfaz o novo ciclo. |
| Ticket sem Trabalho registrado na fábrica | Dependência externa: exige `state=closed` e `state_reason=completed`. |
| Externo aberto/reaberto, `not_planned`, `duplicate`, motivo ausente/desconhecido | Não comprova conclusão. Não seguir indicação de duplicata para substituir a dependência. |

Exclusão de histórico não transforma Ticket próprio em externo: consultar a memória mínima de ciclo/resultado/merge preservada pelo
[contrato de exclusão](22-observability-retention-contract.md#limpeza-explícita-exclusão-do-histórico-e-cópias-externas), conforme ajuste aprovado na
[revisão cruzada](23-architecture-cross-review.md). O último ciclo entregue continua comprovável; cancelado não satisfaz, e novo ciclo explícito
passa a ser o ciclo avaliado. Memória incompleta não autoriza inferir merge a partir do fechamento da issue.

Registrar a observação usada: origem, identidades das relações/destinos, principal/escopo de leitura sem token, instante, conclusão da paginação/travessia, resultados e motivos. Integrar as evidências ao histórico/impedimentos já definidos, sem nova autoridade ou armazenamento concorrente.

### Reavaliação e efeito sobre o Trabalho

Reavaliar antes de admitir Trabalho à fila como elegível e antes de iniciar, retomar ou reparar uma Execução; não usar avaliação antiga como autorização de novo despacho. A seleção/admissão durável segue o contrato de estados e filas.

A API não fornece snapshot transacional do grafo nem transação com o despacho local. Mudanças posteriores são observadas por polling configurável e pela revalidação antes do despacho; não prometer detecção instantânea ou eliminar toda corrida remota.

Se um novo bloqueador ou perda de confiabilidade da leitura for observado durante Execução ativa, impedir a próxima ativação e retirar prontidão. Não cancelar implicitamente o Builder: a Execução ativa pode concluir e publicar seu resultado. Nenhum PR é declarado pronto enquanto persistir esse impedimento. Liberação continua sujeita a todos os demais gates.

| Situação | Tratamento observável |
| --- | --- |
| Dependência identificada ainda não satisfeita | Mostrar bloqueador e motivo; polling observa conclusão válida e permite seleção normal sem segunda aprovação humana por Ticket. |
| Avaliação inconclusiva | Mostrar origem, etapa/problema, última avaliação completa e ação necessária; evidência anterior não libera. |
| Erro transitório/rate limit de leitura | Repetir acompanhamento com espera apropriada e respeito aos headers, sem disparar Builder nem consumir retomada operacional. |
| Falha de autorização/configuração ou incompatibilidade | Exigir correção e revalidação explícita, sem repetição cega. |
| Correção de um impedimento | Não remover suspensão de autorização, pergunta, limite ou outros impedimentos; não restaurar prontidão sem revalidar os gates. |

Impedir os Tickets cuja avaliação dependa do problema, sem bloquear os independentes. Falta de visibilidade que impeça delimitar o impacto não autoriza declarar os demais Tickets daquele escopo seguros; reportar o escopo afetado e a incerteza.

### Validação sem certificação manual por par

Aplicar três níveis, sem exigir experimentos a cada Trabalho:

1. **Desenvolvimento da fábrica:** testes automatizados das regras e testes reais dos cenários de integração que a versão declara suportados.
2. **Configuração da instalação:** pré-voo automático de acesso da App aos repositórios configurados e às consultas necessárias, sem criar issues/arestas de teste em cada repositório. Configuração nova exige verificação de acesso, não aprovação de cada par.
3. **Operação:** consultar e avaliar o grafo real antes do início/retomada. Inacessibilidade, erro ou cenário sabidamente não suportado produzem impedimento explícito.

Atualização do `gh` passa pelos testes da integração; não exige recertificação manual de todos os repositórios. Corrigir falha de acesso/configuração requer revalidar o requisito afetado, não repetir toda a bateria. Renovar token com as mesmas concessões não significa nova combinação de suporte.

Preservar versões/configuração e referências de testes para rastreabilidade, sem criar um cadastro de certificação de todos os pares possíveis.

### Testes futuros e aplicação concreta

“Provas” são testes com resultado observável durante construção e aceite, não rito manual antes de cada execução. Sua realização exige etapa/autorização posterior; esta resolução aprova o contrato, não certifica a instalação.

**Testes sem GitHub, automatizados:** simular respostas e término do subprocesso para cobrir paginação com páginas pequenas, falha após página já emitida, JSON inválido, identidades com números iguais em repositórios distintos, ciclos transitivos, destinos inacessíveis, motivos de fechamento, índices de ciclos próprios, reavaliação antes de despacho, perda de prontidão durante Execução e recuperação sem reutilizar evidência antiga como autorização. Resultado exigido: nenhum desses casos libera indevidamente Builder/prontidão. Não é necessário executar modelo para testar a decisão de controle.

**Integração real em repositórios de teste, com a App e perfis de acesso pretendidos:** criar relação nativa conhecida entre issues, conferir leitura completa e bloqueio enquanto pendente, concluir legitimamente e observar liberação. Cobrir cenário local e cenários entre repositórios/owners/visibilidades que se pretenda declarar suportados, sem inferir suporte de todos os pares possíveis. Forçar paginação pequena; verificar merge próprio versus fechamento isolado e fechamento externo conclusivo versus não conclusivo.

Para a lacuna de visibilidade, preparar relação conhecida com acesso suficiente e repetir com acesso reduzido ao destino, quando o GitHub permitir o cenário. Se houver erro/indício de inacessibilidade, a fábrica deve bloquear. Se a API omitir silenciosamente a relação e não houver mecanismo para detectar a omissão, registrar incompatibilidade com a garantia exigida e voltar ao operador; sucesso do comando não aprova o cenário.

**Piloto:** demonstrar em repositórios-piloto que Ticket real espera por dependência e só inicia após satisfação válida, conectando CA-02 e CA-10 ao fluxo CA-01. Não repetir toda a bateria de manipulação de acesso em cada repositório de uso. Seleção de pilotos e organização completa das provas pertencem à cobertura final do mapa.

### Limite de garantia e encaminhamentos

Enumerar todas as relações acessíveis, ler todos os repositórios configurados ou obter contagens iguais **não prova inexistência de arestas invisíveis**. Nenhuma alternativa de cliente oferece essa garantia ou snapshot transacional. Teste positivo isolado, declaração humana e Markdown não substituem demonstração de suporte suficiente; não há comando implícito de ignorar esse impedimento.

A compatibilidade real permanece a demonstrar nos cenários suportados. Se os testes revelarem omissão silenciosa não detectável, a decisão de produto/desenho retorna ao operador com o impacto; não ampliar credenciais, restringir produto ou liberar execução silenciosamente. Não foi adotada promessa de detecção de mudança remota invisível.

- [Definir a avaliação de checks obrigatórios e prontidão do PR](10-readiness-checks-contract.md): aplicar a invalidação por impedimento de dependências aos demais gates de prontidão.
- [Definir o contrato de permissões e verificação da GitHub App](11-github-app-contract.md): concretizar concessões/pré-voo de leitura, sem reabrir identidade ou expor a chave aos workers.
- [Definir a configuração, a CLI e o ciclo operacional da instalação](21-installation-operations-contract.md): distribuir `gh`, configurar adapter/ambiente e revalidar acesso sem certificação manual por par.
- [Definir observabilidade, proteção de segredos e retenção dos artefatos](22-observability-retention-contract.md): expor impedimentos/evidências com proteção dos tokens.

Os testes futuros não são decisões abertas disfarçadas: o comportamento exigido e o tratamento de incompatibilidade estão definidos. Não foram executados nem considerados aprovados por esta resolução. Nenhum ticket de implementação ou experimento foi aberto nesta cartografia.

### Fontes da comparação complementar

- [Manual `gh api`](https://cli.github.com/manual/gh_api): REST/GraphQL, headers, método, paginação e agregação.
- [Campos de `gh issue view`](https://cli.github.com/manual/gh_issue_view): dependências e estado/motivo da issue consultada.
- [Construção das queries em `gh 2.98.0`](https://github.com/cli/cli/blob/v2.98.0/api/query_builder.go) e [tipos de issue/destinos](https://github.com/cli/cli/blob/v2.98.0/api/queries_issue.go): formato das conexões e campos dos destinos.
- [Execução API em `gh 2.98.0`](https://github.com/cli/cli/blob/v2.98.0/pkg/cmd/api/api.go): páginas sequenciais, emissão de saída e erros.
- [Ambiente e precedência de credenciais](https://cli.github.com/manual/gh_help_environment) e [códigos de saída](https://cli.github.com/manual/gh_help_exit-codes).
- [REST issue dependencies](https://docs.github.com/en/rest/issues/issue-dependencies).
- [Autenticação como instalação de GitHub App e Octokit](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation).

Ajuda/versão locais conferidas sem autenticação; fontes vivas não são certificação do serviço. A referência documental inicial e suas limitações permanecem no relatório imutável ligado pela pesquisa GitHub.
