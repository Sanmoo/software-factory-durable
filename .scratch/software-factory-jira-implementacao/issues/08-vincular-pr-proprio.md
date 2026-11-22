# 08: Vincular o Card ao PR próprio, inclusive após abertura incerta

**What to build:** No Card, a equipe encontra o PR do Trabalho, mesmo em rascunho. Se a resposta da abertura se perder, a fábrica não adota um PR humano nem abre outro às cegas.

**Blocked by:** [04 — Admitir uma única vez no destino revalidado](04-admitir-no-destino-revalidado.md)

Status: ready-for-agent

- [ ] Abrir no destino autorizado com referência legível ao Card, sem closing keyword GitHub nem timeline de issue espelho. Para recuperar, exigir leitura completa e candidato único por repositório, branch, base, autoria GitHub da fábrica e marcador de publicação.
- [ ] Mera menção, ambiguidade ou leitura incompleta não permite adoção, nova abertura ou anúncio de entrega. Fixada a identidade, reler o PR por ela, inclusive após mudança de chave do Card.
- [ ] Fixar o PR e guardar a intenção de remote link no mesmo commit. Reconciliar por globalId estável do Trabalho, mantendo a URL. Fechamento sem merge atualiza o título do mesmo vínculo sem marcar Entregue.

Referência: [spec aprovada](../../software-factory-jira/spec.md), §5; [matriz de aceite offline](../../software-factory-jira/issues/08-testes.md#answer).
