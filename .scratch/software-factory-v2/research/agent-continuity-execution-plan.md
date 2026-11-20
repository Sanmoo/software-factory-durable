# Continuidade do agente entre boots em Lambda — plano de execução (proposta para autorização)

Data: 2026-11-20. Ticket: [Validar a continuidade do agente entre boots em Lambda MicroVMs](../issues/09-agent-continuity-on-lambda-proof.md).
Base: [resultados da prova de infraestrutura](lambda-proof-results.md) e o runner de continuidade da
[prova de harnesses](harness-proof-terminal-summary.md). Rubrica proposta: [rubrica v1](agent-continuity-rubric.json).

**Estado: autorizado pelo Operador em 2026-11-20.** A [rubrica v1](agent-continuity-rubric.json) foi
[aprovada](agent-continuity-rubric-approval.json) e a tabela "Autorização pedida" foi aceita sem ajustes,
inclusive o cleanup total ao final. A primeira inferência ainda depende do manifesto de perfil gravado e do
preflight sem modelo.

## Decisões de formato já tomadas

Respostas do Operador na sessão de 2026-11-20:

- **Adapter:** sessão Pi real do perfil do MVP no host, com `bash`, `read`, `write` e `edit` executando
  na MicroVM pelo SSH sobre WebSocket validado. O Controle é fixture do runner e declarado como tal.
  Não se constrói o adapter Sandbox da v2 nem se usa a composição completa do MVP.
- **Sessão:** provar os dois caminhos. Na troca planejada a mesma sessão continua sobre o ambiente
  reconstruído; na perda antes do push entra uma sessão substituta com contexto explícito.
- **Tarefa:** leve, com estado reconstruível: artefatos ignorados pelo Git e uma imagem Docker local,
  sem Maven nem Testcontainers.

## O que a prova responde

A prova de infraestrutura mostrou que o serviço permite reconstruir. A prova local de harnesses mostrou
sessões novas continuando a partir do `origin`, com Gondolin. Falta juntar as duas coisas e cobrir o caso
que nenhuma tocou: a sessão vive no host e sobrevive à MicroVM, então depois de uma troca ela carrega
lembrança de arquivos, caches e imagens que não existem mais.

## Roteiro

Um Trabalho, três boots, cinco ativações previstas. Cada boot é uma MicroVM nova; nunca duas ao mesmo tempo.

| Passo | Boot | Sessão | O que acontece | Critérios |
| --- | --- | --- | --- | --- |
| 0 | A | nenhuma | Preflight sem modelo: marcador por ferramenta, inventário, gate, contador de efeitos em 0. | A1, A2 |
| 1 | A | S1 | Fase 1 da tarefa: implementar, gerar artefatos ignorados, construir a imagem Docker, verificar, commit e push. | B1 |
| 2 | A | S1 | Início da fase 2 sem publicar; o runner emite o aviso de troca planejada. O agente publica WIP. Gate, término, cessação confirmada. | R1, I2 |
| 3 | B | S1 | Boot novo clonado do remoto. Aviso de reconstrução à mesma sessão, que conclui a fase 2. | R2, P3, I1 |
| 4 | B | S1 | Fase 3: commit local sem push, arquivo não versionado e a chamada do efeito externo `e1`, que publica e fica em espera. Com o contador em 1, o runner encerra a MicroVM sem gate. | R3, P1, E1 |
| 5 | C | S2 | Boot novo do último OID publicado. Sessão substituta recebe o pacote de contexto com a perda e `e1` incerto, e conclui a fase 3 sem repetir o efeito. | P2, P3, E1, I1 |
| 6 | nenhum | nenhuma | Cessação, coleta, sanitização, avaliação por critério, cleanup de tudo, inclusive o herdado. | C1, C2 |

Detalhes que definem os oráculos:

- **Limite reduzido.** As MicroVMs dos boots A e B nascem com `maximumDurationInSeconds` de 900. A margem
  declarada é de 300 s: o aviso de troca sai quando a ativação 1 termina ou aos 600 s de vida, o que
  vier primeiro. O serviço encerraria de fato a MicroVM aos 900 s.
- **Aviso de reconstrução (passo 3).** Diz que o ambiente foi recriado a partir do OID publicado e que
  só o que está no Git existe. Não lista o que sumiu nem ensina a reconstruir: é isso que se observa.
- **Efeito externo.** Um script do repositório sintético que cria um commit em uma ref de efeitos do
  remoto e depois espera. O contador é a quantidade de commits nessa ref, lida do host. O script
  continua disponível nas ativações seguintes; a proibição de repetir vem só do contexto.
- **Verificação.** Toda conclusão de fase é conferida pelo runner em conexão SSH própria e pelo OID
  consultado no remoto. O que o modelo diz, `success` do SDK e exit code do runner não aprovam nada.
- **Barreira.** Fora de uma ativação admitida, as ferramentas recusam e a fronteira de pedidos do SDK
  registra qualquer tentativa.

## Perfil previsto

Fixado no manifesto pelo modo de plano do runner, antes de pedir a liberação da primeira inferência:

- Referência: `main` deste repositório no commit em que o runner for construído (hoje `3646214` na
  integração do MVP), Node 24.21.0.
- Harness: Pi coding-agent 1.5.2 no perfil `factory-development-pi-1.5.2-read-async-bash-lexical-v3`,
  carregado do staging já existente no checkout de integração, somente leitura.
- Modelo: `openai` / `gpt-6-luna` / `openai-responses`, o do perfil de release do MVP, pela autenticação
  OAuth nativa já existente no armazenamento do Pi. Nenhuma credencial é lida, copiada ou impressa por
  mim; variáveis `OPENAI_*` presentes interrompem a execução.
- Ferramentas da sessão: só as quatro do adapter; nativas, extensões, skills e prompts vazios;
  compactação e retry desligados.
- Guest: imagem retida `sfv2proof-full`, sem rebuild previsto; usuário `builder`; deploy key do
  repositório sintético já existente.
- Proteção do ensaio: o filtro de Records do MVP, a partir do build existente, com a deploy key e os
  tokens registrados como segredos. É salvaguarda, não critério.

## Autorização pedida

| Item | Proposta |
| --- | --- |
| Conta, região, identidade | As da prova anterior: conta da AWS CLI local, `us-east-1`, role `sfv2proof-operator`. Sem ampliar a política; se faltar permissão, volto ao Operador. |
| Tamanho | Baseline 1 GB / 0,5 vCPU, pico 4 GB / 2 vCPU, ARM64. Uma MicroVM por vez. |
| MicroVMs | Até 12 execuções e 3 MicroVM-horas no total; `maximumDurationInSeconds` de 900 nos boots do roteiro e nunca acima de 1800. |
| Builds de imagem | Nenhum previsto; até 2 se a imagem retida não servir, com o motivo registrado. |
| Custo AWS | Teto de US$ 10, parada obrigatória ao estimar US$ 7. |
| Modelo | `gpt-6-luna` pela assinatura já autenticada. Até 12 ativações (5 previstas), 15 pedidos de modelo por ativação, 120 no total, 6 minutos por ativação. Sem fallback de modelo ou de autenticação. |
| Correções | Posso corrigir defeitos do runner e repetir um passo dentro desses tetos, registrando cada repetição. Não posso relaxar critério, trocar modelo nem subir teto. |
| Repositório | Reusar o repositório sintético privado, em branches próprias desta prova. Nenhum código da fábrica entra no guest. |
| Prazo | Até 2026-11-25. Vencido o prazo, cleanup mesmo com passos incompletos. |
| Cleanup | Ao final, remover tudo: o desta prova e o herdado (imagens, bucket, log groups, roles, repositório e deploy key, chaves locais), com leitura do Cost Explorer. Se preferir reter algo, dizer o quê. |

## Regras de parada

- Qualquer teto atingido, prazo vencido, modelo ou perfil diferente do manifesto, ou sinal de fallback:
  parar, preservar a evidência e voltar ao Operador.
- Nenhuma MicroVM viva entre sessões de trabalho; toda sessão termina com a listagem sem itens ativos.
- Recusa de permissão, falta de capacidade ou quota: registrar e voltar, sem outra região ou conta.
- Critério contratual reprovado é resultado. Não repito o cenário até passar: uma repetição só se
  justifica por defeito do runner ou do oráculo, e fica registrada com o motivo.

## Evidência e integração

- Finalização pelo [helper dos guardrails](../../../docs/agents/experiment-proofs.md): cessação, coleta,
  sanitização, avaliação com exatamente os IDs da rubrica, e só então remoção.
- Evidência bruta em diretório privado novo fora do repositório. Para a `main` vão a rubrica, a
  aprovação, este plano, o relatório, a avaliação por critério e os registros sanitizados: sem tokens,
  chaves, ID de conta, conteúdo de `runHookPayload` ou transcript bruto.
- Código descartável na branch `prototype/v2-agent-continuity`, derivada de `prototype/v2-lambda-microvms`,
  nunca integrada.
- As sessões Pi ficam preservadas até a avaliação; depois seguem a política de remoção do cleanup, com
  os hashes no relatório.

## Fora desta prova

Suspend/resume, oito horas reais, carga sustentada, repositório real, revisores, filtragem como
critério, o módulo Sandbox da v2 e qualquer troca de harness.
