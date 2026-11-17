# Integração documental do aceite local Pi/Claude

Resolução canônica: [Validar Pi e Claude Code nos contratos de execução e continuidade](../issues/07-harness-compatibility-prototype.md#answer).
Relatório aceito: [barreira nativa, erro de filtro e efeito contado](harness-proof-terminal-summary.md).

## Destino e autorização

Destino originalmente registrado e mantido: **main no checkout principal**
`/home/sanmoo/dev/github.com/Sanmoo/software-factory-durable`, em
`0a8b9c61eaf8cb9fd62c3e5a3a9ae6c8c94221be` ao iniciar esta integração.

O Operador aprovou o aceite contratual local C1–C12, com a falha da edição auxiliar explicitamente
preservada, e autorizou uma exceção para criar **somente** a branch/worktree temporária documental:

- Branch: `docs/harness-proof-acceptance`.
- Worktree: `.worktrees/docs-harness-proof-acceptance/`.
- Integração local por `git merge --ff-only`, sem merge integral do protótipo ou push.
- Remover apenas esses recursos temporários depois de confirmar integração e worktree limpa.

A integração não executa modelos, SDKs, Sandbox ou testes nativos, nem autoriza repetição das
campanhas encerradas. Também não avança outro ticket ou modifica PRD/spec do MVP.

## Proveniência e preservação

Snapshot documental de origem: **951eb09ad2906f0f077f9ef0be8502ae5b42b0e5**, na branch local
**prototype/v2-harness-proof**, worktree **.worktrees/harness-proof-run/**.
Esse commit contém a resolução aprovada e o índice no mapa, além do histórico da prova.

Foram transportados somente:

- o ticket resolvido e o índice do mapa;
- relatórios Markdown da prova e sua interpretação histórica;
- JSONs de evidência sanitizada, incluindo resultados negativos, consumo e auditorias de cleanup;
- esta nota e o [manifesto de importação](harness-proof-documentary-import.json).

Os **16 JSONs de evidência** são preservados byte a byte em relação ao snapshot de origem.
O manifesto registra SHA256 de cada arquivo fonte e de sua versão documental integrada. Ajustes
editoriais ficam restritos ao ticket, relatório final e histórico de resultados: aprovação,
proveniência desta integração e conversão de um link de código em ponteiro para a branch local.
Não se reescrevem eventos, resultados ou falhas do ensaio.

A spec aprovada e os demais tickets permanecem intactos. As ressalvas de RESUMED, exits 1 e o
alcance finito de C12 continuam na resolução e nos relatórios. Os textos históricos que dizem
claimed, proposta ou aguardando aprovação descrevem o momento do ensaio; não substituem a Answer.

## Código descartável e recursos deliberadamente retidos

**Nenhum arquivo de `.scratch/software-factory-v2/prototype/`, `.runtime/`, dependência, binário,
configuração de build ou alteração de implementação entra em main.** A branch experimental não é
ancestral de main por esta operação: apenas seus registros selecionados são importados.

Código e commits produtores continuam disponíveis localmente na branch `prototype/v2-harness-proof`.
Por exemplo, para leitura sem executar a prova:

```sh
git show 951eb09ad2906f0f077f9ef0be8502ae5b42b0e5:.scratch/software-factory-v2/prototype/terminal-proof.mjs
git show 951eb09ad2906f0f077f9ef0be8502ae5b42b0e5:.scratch/software-factory-v2/prototype/terminal-evidence-audit.mjs
```

Esses caminhos pertencem à branch original, não ao checkout main. Nenhuma URL de branch remota é
presumida: **não houve push**. Os hashes/commits que produziram cada tentativa continuam nos seus
manifestos/evidências, não são substituídos pelo commit desta importação documental.

A branch/worktree originais, o snapshot de referência, dependências locais e metadados próprios
são deliberadamente preservados para reprodução/auditoria. Não devem ser removidos como se fossem
os recursos temporários desta integração. VMs, sessões e executores temporários da prova já têm
cleanup registrado nas evidências; esta operação não cria novos desses recursos.
