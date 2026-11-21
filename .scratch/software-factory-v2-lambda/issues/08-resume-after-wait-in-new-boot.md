# 08: Retomada após espera em novo boot

**What to build:** Respondida a Pergunta (ou terminada a espera de CI ou prontidão), o Trabalho retoma num boot novo, reconstruído do Git remoto e da
declaração de ambiente, com a mesma sessão quando a continuidade é compatível. Toda ativação em um boot diferente do último que a sessão
viu começa com um aviso fixo do Controle.

Requisitos da [spec da v2](../../software-factory-v2/spec.md): V2-11; MVP §5.5, §10.1.

Testes automáticos usam um fake do serviço Lambda MicroVMs: o CI não tem conta AWS. Seguir `docs/agents/testing.md`; gate `npm run test:ci`.

**Blocked by:** 07

**Type:** task

**Status:** ready-for-agent

## Acceptance criteria

- [ ] A retomada inicia um boot novo a partir da ponta da branch no `origin`; nada do boot anterior é adotado.
- [ ] A primeira ativação num boot diferente do último que a sessão viu começa com o aviso fixo: ambiente recriado, commit de partida, e que arquivos ignorados, caches e dados do Docker não existem mais.
- [ ] A mesma sessão continua quando a ponta da branch no `origin` é o commit confirmado pelo gate ou descende dele; o aviso lista os commits novos.
- [ ] Retomada com commits de terceiros sobre o commit confirmado: mesma sessão, commits listados no aviso (gate de validação da spec, não provado no protótipo).
- [ ] Histórico reescrito ou branch ausente segue a regra de divergência do MVP, sem regra nova.
- [ ] Ativações seguintes no mesmo boot não repetem o aviso.
- [ ] A retomada após espera não consome retomada operacional.
