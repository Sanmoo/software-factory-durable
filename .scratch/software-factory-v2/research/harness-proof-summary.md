# Prova local Pi/Claude — síntese da campanha limitada

**Registro histórico da campanha encerrada em 20 ativações.** A proposta mais recente está na
[rodada de barreira nativa](harness-proof-terminal-summary.md), posterior à revisão sem modelos
e às dez ativações complementares. Ela propõe fechar os critérios no recorte local, com ressalva
explícita de subteste de edição não concluído e interpretação limitada de C12, para aprovação do
Operador. Nenhum aceite foi registrado no ticket/mapa. O texto abaixo preserva o estado anterior.

Asset de [Validar Pi e Claude Code nos contratos de execução e continuidade](../issues/07-harness-compatibility-prototype.md).
Desenho: [Prova local de harnesses substituíveis](../harness-proof-spec.md).
Histórico, incluindo erros do ensaio: [Resultados detalhados](harness-proof-results.md).

## Veredito

**INCONCLUSIVO para aceitar o conjunto local completo.** Foram demonstradas partes importantes do
encaixe e a continuidade real Pi → Claude → Pi, mas critérios obrigatórios permanecem sem evidência
suficiente. Não homologar integração de produção, composição Lambda ou todos os perfis mistos.

A campanha encerrou suas chamadas a modelos ao atingir **20 ativações**, sem ampliar o teto,
recomeçar contagem, mudar modelos ou usar API paga. O ticket permanece claimed: além das lacunas,
esta sessão já resolveu o ticket da spec e não deve resolver um segundo ticket Wayfinder.

## O que se demonstrou

1. **Claude Haiku oficial nos três papéis.** Builder alterou/testou a fixture no guest. Após corrigir
   o bridge descartável de read/capture/page, Standards e Spec produziram pareceres PASS sobre os
   arquivos reais; uma sessão substituta de Builder recebeu e conferiu os dois. Revisores foram
   sequenciais e a entrega foi coordenada pelo runner, não pelo Controle de produção.
2. **Pergunta e preservação local.** Claude leu conteúdo filtrado, fez WIP commit/push no origin local,
   o gate confirmou workspace limpo, sem stash e HEAD igual à branch consultada no remoto. Pergunta
   foi gravada/sincronizada antes do ACK local; a ativação foi encerrada, sem Promise aguardando humano.
   Resposta humana foi fixture explicitamente identificada; outro processo/ativação retomou o fluxo.
3. **Pi → Claude → Pi reais.** Pi OpenAI gpt-6-luna publicou P1; Claude Haiku leu P1 em clone novo e
   publicou C2; uma nova sessão Pi leu P1/C2 e publicou P3. Sessões nativas distintas, sem passar
   transcripts ou resumos do executor anterior. Work id lógico `harness-proof-local-v7` mantido.
   OID remoto final confirmado: `5b2d041ce0966612bcfdb739209644e4d2750810`.
4. **Perda local explícita.** Arquivo não publicado foi criado e seu clone descartado. Novo clone não
   continha esse arquivo, preservava os commits do origin e recebia o registro da perda. Pi final
   reconheceu a perda e o efeito e1 ainda incerto. Bloqueio de e1 é fixture, não prova de idempotência.
5. **Observações de segurança delimitadas.** Inventários Claude sem built-ins e somente MCP definido;
   Pi corrigido com loadout explícito factory_bash, verificado antes da inferência. Backend recusou
   escrita/Bash/traversal de revisor. Canário sintético dividido em chunks foi filtrado pelo Records
   antes do retorno MCP; o scan dos JSONL nativos próprios pertinentes não encontrou o valor bruto.
   Não extrapolar isso para todos os logs auxiliares ou casos de falha de filtragem.

## Matriz final por critério da spec

| Critério | Resultado | Evidência e limite |
| --- | --- | --- |
| C1 — tarefa e três papéis Claude | Aprovado no recorte local | Builder real + verificador guest; pareceres reais válidos após reteste do bridge. Artefato do Builder anterior restaurado na revisão corretiva; não alegar uma única execução contínua. |
| C2 — dois pareceres e consumo | Aprovado no recorte local | Entrega explícita e resposta de Builder citando ambos; Controle real não foi integrado. |
| C3 — suspensão sem novas inferências | Inconclusivo | Processos Builder encerrados antes dos revisores; falta oráculo completo pré-request/background/descendentes. |
| C4 — confinamento e read-only | Inconclusivo | Inventários e três recusas reais observados; cobertura dirigida de symlinks e demais fronteiras incompleta. |
| C5 — filtragem antes do harness | Inconclusivo | Split canary e scan nativo próprios passaram; falha de filtro e todos os auxiliares não foram auditados. |
| C6 — pergunta/ACK/gate/retomada | Inconclusivo | Caminho local positivo; ACK é do registro fixture, sem prova de Controle real nem barreira pré-request completa no intervalo até cessação. |
| C7 — cancelamento em tool e cessação | Inconclusivo | Paradas normais e cleanup confirmados; cenário nativo de cancelamento durante tool não executado antes do teto. |
| C8 — duas direções/novas sessões | Aprovado no recorte local | P1/Pi → C2/Claude → P3/Pi, com sessões distintas, seleção explícita sequencial e origin confirmado. Não é comando/configuração de produção. |
| C9 — contexto, histórico e controles | Inconclusivo | Contexto sem transcript suficiente para a tarefa e registros fixture estáveis; contabilidade/histórico duráveis do Controle de produção não exercitados. |
| C10 — ambos os perfis mistos | Inconclusivo | Ensaio misto inicial teve Pi sem tools ativas; revisor Pi recebeu recusa nativa de política. Sem pareceres Pi válidos ou reteste completo. |
| C11 — perda antes de push | Aprovado no recorte local | Clone descartado, perda registrada, origin preservado e sessão substituta ciente. Transporte/vida limitada Lambda não testados. |
| C12 — efeito externo incerto | Inconclusivo | e1 foi impedimento declarado em fixture; não houve serviço de efeitos com contador independente que comprovasse ausência de replay. |

Nenhuma linha inconclusiva pode ser promovida a aprovação por exit 0 do runner ou autodeclaração do
modelo. Erros corrigidos do protótipo ficam no histórico; não são incompatibilidade já provada dos
harnesses. A recusa de política do provider Pi não foi contornada, reescrita para evasão ou substituída
por outro modelo/cobrança.

## Fronteiras reais, simuladas e diferenças v2

- Reais: binários/SDKs, assinaturas nativas, ferramentas Sandbox/Gondolin, filtragem Records, Git local,
  push, consulta do origin, novos clones, commits, processos e boots próprios.
- Simulados: admissão/ledger e histórico do Controle, resposta humana, impedimento de efeito externo.
- WIP/push antes da espera e reconstrução foram implementados somente no roteiro descartável.
  O MVP fixado continua com publicação separada e exigência de ambiente reutilizado; não foi alterado.
- Bare origin ficava separado dos clones. Para continuar em guest novo, o ensaio realocou somente
  esse repositório remoto por cópia de arquivos confiável no host, sem executar Git/código guest no
  host. Clones seguintes e consultas remotas ocorreram no guest. Isso não define checkpoint de
  produção nem comprova um serviço remoto/transportes finais ou reconstrução integral da fábrica.

## Perfil e contabilidade

- Referência imutável: `aabe06abfb20e83593020c0fee19b078d235466b`. Nenhuma implementação mais recente adotada.
- Node 24.21.0; Claude Code oficial 2.1.325; Agent SDK 0.3.325; Haiku `claude-haiku-5-5`, esforço low.
- Pi coding-agent 1.5.2 com perfil Factory v3; OpenAI `gpt-6-luna`, native openai-responses/OAuth.
- Gondolin 0.14.0 com perfil Factory v1; 1 vCPU, 1024 MiB, disco virtual 4 GiB; mesmo pin de imagem
  registrado nos manifests. Não houve instalação global, AWS, GitHub real ou alteração do MVP.
- Claude usou autenticação pessoal existente por exceção explícita, sem copiar tokens. Pi usou seu
  OAuth nativo existente, sem recursos/configuração pessoal e sem API key. Login/logout não realizados.
- Contagem: 1 recusa de quota + 1 consulta mínima + 1 Builder parcial + 4 ativações J1 + 3 revisões/
  retorno corretivos + 7 ativações do primeiro roteiro de continuidade + 2 fases P1/C2 + 1 P3 = **20**.
- Uma reserva ordinal 20 falhou em mkdir antes de ModelRuntime/createAgentSession/prompt; foi liberada
  por ausência comprovada de ativação, não por restituição presumida de consumo remoto.
- Tempo de execução real debitado conservadoramente: cerca de 22 minutos, incluindo reservas pelos
  checks sem modelo; esperas por resposta humana não contam como execução real. Teto de 60 min mantido.
- Usage e estimativas monetárias dos SDKs são observações, não saldo do plano ou fatura. Zero em
  resposta sintética/erro não prova consumo total zero. Sem fallback ou modalidade API paga.

## Evidências principais

- [Revisões corrigidas e retorno ao Builder](harness-proof-attempt-5.json).
- [Pergunta, gate e primeiro roteiro misto](harness-proof-attempt-6.json).
- [P1 e C2 publicados; diagnóstico do oráculo](harness-proof-attempt-7.json).
- [Reserva não consumida antes de sessão/modelo](harness-proof-attempt-8.json).
- [P3 e continuidade final](harness-proof-attempt-9.json).
- Código e versões dos runners ficam na branch descartável `prototype/v2-harness-proof`, sem push.
  Cada evidência indica o commit que realmente a produziu; correções posteriores não reescrevem resultados.

## Cleanup e trabalho restante

Boots de todas as tentativas cessados. Disk/workspace/artifacts/runtime dos ambientes executados
removidos pelo Sandbox público; a preparação original que nunca teve boot foi removida por cleanup
restrito de seus próprios arquivos. Hardlinks criados pela otimização Git local causaram recusa de
cleanup em uma tentativa: aliases foram comprovados como internos ao workspace próprio pelo total
nlink, removidos nesse escopo e a API pública concluiu a remoção. Novos clones usaram --no-hardlinks.

Sessões nativas Claude criadas no cwd exclusivo da prova foram removidas pelo helper oficial,
sem logout, remoção de perfil pessoal ou de sessões alheias. Perfis Pi e capturas temporárias próprios
foram removidos após sanitização da evidência. Metadados de lifecycle/cleanup e dependências/cópia do
snapshot permanecem para reprodução e auditoria, sem VM ou escritor ativo.

O próximo esforço precisa de orçamento novo e focado nas lacunas da matriz, não de repetir a prova
inteira. Não executar mais modelos nesta campanha. Ticket e branch/worktree ficam preservados; o
código descartável não deve ser integrado ao MVP. A composição e qualquer interface de produção
continuam reservadas às decisões posteriores do mapa.
