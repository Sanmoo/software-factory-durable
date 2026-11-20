# 59: Limite de sincronização de segredo abaixo do orçamento do Builder

**What to build:** cada requisição ao modelo chama `getAuth` (`src/workers/factory-oauth.ts`), que envia o token ao dono por
`acknowledgeSecrets`. O receptor do dono (`createOwnerSecretReceiver`, `src/platform/host/worker-secret-ipc.ts`) encerra o canal quando
`seen.size >= 128`, e a Execução termina `WORKER_EXECUTION_UNCERTAIN`. O orçamento do Builder é de 150 requisições (`builderBudgetV1`), com
máximo por repositório maior. No piloto 2, o Builder do #126 morreu na requisição 126 (05:15:10, sessão `w-Prr470`) e o do #124 na 127
(04:59:34), ambos com zero tokens, 6 ms após o início, mascarados como `WORKER_PROVIDER_UNAVAILABLE`. O dono não registra a contagem nem por
que o canal falhou.

**Blocked by:** —

**Type:** task

**Status:** ready-for-agent

## Acceptance criteria

- [ ] Um Builder dentro do seu orçamento máximo (requisições e renovações de token) nunca esgota a sincronização de segredos; o limite
  continua existindo (sem crescimento sem limite) e é derivado do orçamento, não um número solto.
- [ ] Reenviar um segredo já registrado não consome o limite (ou não é reenviado), mantendo a proteção contra replay de id.
- [ ] Quando o dono encerra o canal, o motivo (fechado, sem prefixo de valores) fica registrado e chega ao Control como causa própria, não como
  falha do provedor.
- [ ] Teste: sessão com mais requisições que o antigo limite de 128 continua; excesso real do novo limite é recusado com o motivo registrado.

## Comments

- Achado pelo ticket 57 (`## Answer`); evidência em `/home/sanmoo/software-factory-test/pl2-pilot-evidence/findings.md` item 10.
