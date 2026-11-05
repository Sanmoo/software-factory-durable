# Investigar APIs e permissões GitHub para os controles do MVP

Status: resolved
Claimed by: pesquisador delegado pelo responsável do mapa
Research branch: research/software-factory-github
Research worktree (histórica; removida limpa após verificação): /home/sanmoo/dev/github.com/Sanmoo/pkm/.worktrees/sf-research-github
Context: cartografia Wayfinder aprovada nesta conversa; pesquisa documental AFK delegada.
Research workflow: 1cb0b420-981c-4677-86ed-705118696c24
Research state: pesquisa documental verificada e publicada; resolução não implica escolha técnica.
Local report: [Relatório preservado](../research/github-capabilities.md)
Type: research
Label: wayfinder:research
Map: [Especificar tecnicamente o MVP da Software Factory](../map.md)
Blocked by: none

## Question

Quais APIs, permissões e restrições reais do GitHub.com sustentam os controles do PRD, e quais controles precisam permanecer na fábrica?

Verificar relações nativas blocked by/blocking, paginação e completude, escopo entre repositórios/organizações, ciclos e motivos de encerramento; identidade estável de issue/PR/autor e operadores; labels/elegibilidade; checks obrigatórios e rulesets/proteções aplicáveis ao commit atual; conflito indeterminado, drafts e prontidão; reviews CHANGES_REQUESTED; comentários/respostas correlacionadas; merge confirmado e PR fechado sem merge; descoberta após efeitos ambíguos de criar PR/pergunta.

Comparar capacidades e limites de GitHub App installation tokens e fine-grained PATs, especialmente se é possível permitir escrita na branch de trabalho e impedir tecnicamente merge, administração ou push na base com a credencial proposta. Não confundir escopo de token com restrição de branch; explicitar dependência de configuração/plano/ruleset, bypass e permissões do controlador. Verificar o uso de force-with-lease com referência esperada e limitações relevantes.

Usar documentação/API/código oficiais, registrar versões quando aplicável e data de consulta. Não assumir ausência de bloqueadores/checks após consulta incompleta. Indicar limitações e provas necessárias; não escolher autenticação ou fronteira de autoridade pelo humano.

Pesquisa documental apenas, sem tokens reais, chamadas privadas, criação de recursos ou alteração de configuração GitHub. Relatório em `.scratch/software-factory/research/github-capabilities.md`, em branch de pesquisa separada, nunca integrada.

## References

- [PRD — Software Factory MVP](../prd.md): RF-01–02, RF-08–11, RF-14; RNF-01–02 e RNF-04; CA-02, CA-04–06, CA-09–10.

## Comments

- Criado na cartografia aprovada; não é ticket de implementação.
- Supervisor verificou relatório e publicação após a conclusão do workflow de pesquisa.

## Answer

Pesquisa documental concluída e verificada pelo responsável do mapa. [Relatório imutável](https://github.com/Sanmoo/pkm/blob/c4c46ed436570c457e19d5e2a31cb59921b89dcd/.scratch/software-factory/research/github-capabilities.md), commit `c4c46ed436570c457e19d5e2a31cb59921b89dcd`, branch `research/software-factory-github`. Consulta em 2026-11-03 UTC; contrato REST analisado `2026-03-10`, sem presumir paridade de versões.

- Dependências nativas e motivos de fechamento estão documentados. Cross-org e comportamento de relações ocultas por permissão não têm garantia suficiente na evidência; enumeração completa de relações acessíveis não prova inexistência de arestas invisíveis.
- Prontidão exige descobrir regras aplicáveis e correlacionar checks/statuses ao SHA relevante, inclusive merge de teste quando aplicável. Falha/incompletude de leitura não significa ausência de requisitos ou PR verde.
- `Contents: write` habilita push e endpoints de merge. App/PAT não separam essas operações só pelo escopo do token; contenção depende de identidade, regras ativas e bypasses, ou de intermediação ainda não aprovada.
- Fine-grained PAT tem limitação documental atual para Checks API. Alternativa GraphQL não foi validada como substituto universal. Identidade/credencial não foram escolhidas.
- APIs permitem descobrir PR, comentário e ref após efeito ambíguo, mas não constituem transação com o estado local nem deduplicação universal de POST. Lease explícito protege somente a ref esperada, não a worktree ou mudanças humanas anteriores ao OID capturado.

**Verificação:** relatório lido; referências/links e escopo de diff conferidos; SHA publicado confirmado no remoto. Documentação oficial de permissões App e limitações PAT confrontada por amostragem. O pesquisador registrou 39 fontes e 12 provas propostas; nenhuma prova autenticada/configuração/credencial real foi usada. Esta resolução encerra pesquisa documental, não certifica uma instalação concreta ou autoriza alterar regras.

**Encaminhamento:** evidência para [Definir a fronteira mínima entre controlador e builder](01-control-authority.md) e [Definir estados, filas, persistência e reconciliação dos efeitos](08-state-and-effects-contract.md). Lacunas viram [Definir o escopo suportado e a validação das dependências nativas](09-dependency-compatibility.md) e [Definir a avaliação de checks obrigatórios e prontidão do PR](10-readiness-checks-contract.md), não fallback implícito ou sucesso presumido.
