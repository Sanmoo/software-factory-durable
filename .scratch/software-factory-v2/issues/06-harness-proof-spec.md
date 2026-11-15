# Especificar a prova de harnesses substituíveis com Pi e Claude Code

Status: resolved
Assignee: Operador, assistido pelo Pi nesta sessão
Claim context: branch docs/v2-harness-proof-spec, worktree .worktrees/harness-proof-spec/; destino main no checkout /home/sanmoo/dev/github.com/Sanmoo/software-factory-durable, inicialmente em 36dac7faf47182ebad77dad0ef041ed53381d1b0. Referência MVP imutável aabe06abfb20e83593020c0fee19b078d235466b. Somente entrevista e registros documentais, sem execução nem push; asset após confirmação do entendimento e resolução somente após aprovação explícita.
Type: grilling
Label: wayfinder:grilling
Map: [Software Factory v2 — ambientes reconstruíveis e harnesses substituíveis](../map.md)
Blocked by: 05

## Question

Qual experimento limitado demonstra os requisitos aprovados de execução e continuidade com Pi e
Claude Code sem antecipar a interface de produção nem depender da homologação de Lambda?

## References

- [Direção aprovada](04-substitutable-harnesses-direction.md#answer).
- [Investigação da interface de execução](05-execution-seam-research.md).
- [Prova Lambda independente](02-lambda-microvms-prototype.md).
- [Spec da prova local Pi/Claude](../harness-proof-spec.md) — asset aprovado explicitamente pelo Operador.

## Scope

- Produzir spec da prova em documento auxiliar desta feature, com requisitos, hipótese, fixtures,
  versões/perfis, comandos previstos, evidência esperada e critério de aprovação por cenário.
- Cobrir Claude nos três papéis e fluxo combinado; perguntas/ACK/suspensão/retomada; read-only real;
  confinamento; cessação/cancelamento/crash; efeitos incertos; Pi → Claude e Claude → Pi por parada,
  alteração de configuração e reinício. Incluir preservação e perda sem presumir sessões convertíveis.
- Separar cenários determinísticos com mocks dos que exigem execução real; fixar qual composição
  local é avaliada e o que permanece sem evidência para Lambda e a composição final da v2.
- Definir como coletar resultados reproduzíveis sem segredos/código privado, consumo com lacunas
  explícitas, falhas induzidas e condições de parada. Aprovado/reprovado/inconclusivo por critério;
  critério obrigatório inconclusivo não permite aprovar a integração.
- Definir autenticação nativa dedicada do Operador e verificar termos atuais. Evitar herança do
  perfil pessoal e API key inadvertida; sem --bare como suposta solução OAuth, extração de tokens,
  compartilhamento de conta, contorno de quota ou fallback pago silencioso.
- Submeter ambiente, assinatura/conta, permissões, limites de consumo/prazo, eventual custo e cleanup
  à autorização específica. Limites não mensuráveis precisam de diagnóstico/condição de parada,
  não ser apresentados como orçamento garantido.
- Decidir somente o necessário ao experimento. Interface implementável e alterações de autoridade
  pertencem à decisão de composição posterior; não congelar abstração com base em um só adapter.

## Comments

- O Operador confirmou o entendimento e solicitou sua síntese em spec. Asset registrado sem execução,
  login, uso de credenciais, modelos, instalação, infraestrutura ou push. Ticket permanece claimed;
  aprovação do entendimento não foi interpretada como aprovação final do documento nem autorização
  para executar. Mapa permanece inalterado até aprovação explícita da spec.
- Recorte final aprovado na entrevista: testar diferenças introduzidas pelo harness, não regressão
  geral do MVP. Três jornadas, dois desvios limitados e checklist operacional curta substituem a
  bateria extensa inicialmente sugerida. Workers é a fronteira candidata, sem interface de produção.
- Mantido somente o rótulo wayfinder:grilling: este é um ticket de decisão, não uma tarefa pronta
  para implementação. A spec é asset do ticket, não um novo ticket de execução.

## Answer

O Operador aprovou explicitamente a [spec da prova local Pi/Claude](../harness-proof-spec.md).
O recorte final é uma prova diferencial de harness, não regressão do MVP: Workers como seam candidato,
Claude oficial via SDK/MCP no host, ferramentas em Gondolin, três jornadas e dois desvios limitados.
Preservação WIP e reconstrução Git são roteiro v2 descartável, não capacidades atribuídas ao MVP.
Resultados obrigatórios distinguem aprovado/reprovado/inconclusivo; manifesto e autorização operacional
precedem execução. Nenhuma interface de produção foi implementada e nenhuma prova foi executada.

Na mesma resposta, o Operador solicitou avançar para executar a prova. Isso permite preparar o próximo
trabalho, mas conta/modalidade, limites numéricos e recursos/cleanup ainda precisam ser confirmados
conforme a checklist. Essa solicitação não dispensa o gate nem autoriza inferir valores ausentes.
O ticket de execução é [Validar Pi e Claude Code nos contratos de execução e continuidade](07-harness-compatibility-prototype.md).

Validação documental do asset e ticket: diff sem whitespace inválido, 12 links/âncoras locais válidos
e probe LSP sem diagnósticos nos dois arquivos. Não constituem validação de runtime.

## Exit criteria

Spec da prova aprovada pelo operador, rastreável à direção e à investigação, sem lacunas críticas
preenchidas por suposição. Registrar separadamente aprovação do desenho e autorização de execução;
resolver este ticket não autoriza automaticamente iniciar o experimento ou inferência.
