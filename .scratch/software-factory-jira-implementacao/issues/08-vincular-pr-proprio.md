# 08: Vincular o Card ao PR próprio, inclusive após abertura incerta

**What to build:** No Card, a equipe encontra o PR do Trabalho, mesmo em rascunho. Se a resposta da abertura se perder, a fábrica não adota um PR humano nem abre outro às cegas.

**Blocked by:** [04 — Admitir uma única vez no destino revalidado](04-admitir-no-destino-revalidado.md)

Status: resolved

- [x] Abrir no destino autorizado com referência legível ao Card, sem closing keyword GitHub nem timeline de issue espelho. Para recuperar, exigir leitura completa e candidato único por repositório, branch, base, autoria GitHub da fábrica e marcador de publicação.
- [x] Mera menção, ambiguidade ou leitura incompleta não permite adoção, nova abertura ou anúncio de entrega. Fixada a identidade, reler o PR por ela, inclusive após mudança de chave do Card.
- [x] Fixar o PR e guardar a intenção de remote link no mesmo commit. Reconciliar por globalId estável do Trabalho, mantendo a URL. Fechamento sem merge atualiza o título do mesmo vínculo sem marcar Entregue.

Referência: [spec aprovada](../../software-factory-jira/spec.md), §5; [matriz de aceite offline](../../software-factory-jira/issues/08-testes.md#answer).

## Answer

O PR próprio de um Trabalho Jira é correlacionado só pela branch do Trabalho (`factory/jira-<issueId>-<w8>`): a leitura branch-only de
`findPublication` devolve, da listagem completa, os PRs dessa branch no repositório autorizado (`branchCandidates`), sem número de issue,
timeline ou closing keyword. A propriedade continua sendo a regra comum (marcador da publicação, App da fábrica como autora, branch, base e
repositório): só um candidato próprio numa leitura completa é fixado; PR humano na branch fica retido/bloqueado, dois próprios bloqueiam e
leitura incompleta nada decide — nunca adoção, nova abertura ou entrega. A descrição exige `Jira Card <KEY>: <site>/browse/<KEY>` e recusa
closing keyword GitHub; a chave é apresentação (a referência escrita antes de `PAG-42 -> FIN-18` continua válida). Fixado o PR, as leituras
seguintes (entrega/fechamento) usam a identidade persistida.

No mesmo commit em que o PR é fixado fica a intenção do vínculo (`factory.jira-link`, formato 3): `globalId` `software-factory:work:<uuid>`,
URL do PR, título `Trabalho T-<n> · Abrir PR`, revisão. Um desk no ciclo do poller faz o upsert por `globalId`
(`POST /rest/api/3/issue/{id}/remotelink`) só do estado desejado mais recente; resposta perdida ou recusa reenvia o mesmo upsert com backoff,
sem segundo vínculo. Fechamento sem merge muda só o título (`PR fechado sem merge`), mesma URL, sem Entregue; reabertura confirmada volta a
`Abrir PR`. A intenção é independente de comentários, limpeza e esquecimento do Trabalho; `status` mostra os vínculos pendentes com diagnóstico.

Commits: d6d4a482 (implementação e testes).
