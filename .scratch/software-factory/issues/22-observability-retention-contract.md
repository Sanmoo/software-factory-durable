# Definir observabilidade, proteção de segredos e retenção dos artefatos

Status: resolved
Assignee: Samuel Santos (operador), assistido por Pi
Claim context: sessão `01a1a608-7862-75a8-bc33-e05f796d23de`; branch `wayfinder/software-factory-observability`; worktree `/home/sanmoo/dev/github.com/Sanmoo/pkm/.worktrees/software-factory-observability`; integração em `main` no checkout `/home/sanmoo/dev/github.com/Sanmoo/pkm`, sem publicação de `main`.
Type: grilling
Label: wayfinder:grilling
Map: [Especificar tecnicamente o MVP da Software Factory](../map.md)
Blocked by: 08, 15, 19

## Question

Quais registros, artefatos e políticas de acesso/retenção permitem explicar e recuperar cada Trabalho,
sem vazar credenciais, apagar contexto necessário ou confundir ausência de medição com sucesso/consumo zero?

Definir correlação e formato/localização de transições, sessões, comandos, revisores, validações, perguntas, efeitos,
tentativas, duração/atividade e uso/custo por papel, incluindo falhas/abortos.
Distinguir resumo persistente de logs detalhados e contexto indispensável à retomada, e dados indisponíveis de zero.
Explicitar o que a CLI expõe por Trabalho e globalmente, reaproveitando a autoridade e o transporte responsáveis.

Definir proteção dos segredos fornecidos pela fábrica, redaction antes de persistência/exibição/publicação,
permissões locais e limites do que pode ser garantido sobre saídas arbitrárias de ferramentas.
Não exigir raciocínio interno, publicar sessões/logs automaticamente no GitHub nem criar auditoria exaustiva do CI.

Concretizar retenção padrão de 30 dias para logs/sessões, configuração e preservação de contexto de Trabalhos abertos,
bloqueados, cancelados ou com PR fechado sem merge. Definir inventário de recursos próprios,
limpeza automática após entrega e explícita para não entregues, falha parcial/repetição e exclusão explícita de resumo/histórico.
Remover ambiente não apaga autoridade/histórico; não executar cleanup global Docker ou remover recursos desconhecidos.
Delimitar retenção e cópias externas sem sugerir que exclusão de um arquivo desfaz efeitos externos; suporte integrado a backup foi retirado pelo contrato operacional.

Saída: contrato de observabilidade, proteção/limites e ciclo de vida dos artefatos, com exemplos e critérios de prova.
Não implementar instrumentação, coletar credenciais, apagar arquivos do operador ou executar cleanup nesta decisão.

## References

- [Definir a fronteira mínima entre controlador e builder](01-control-authority.md).
- [Escolher o runtime de agentes e seus pontos de integração](06-agent-runtime-choice.md).
- [Escolher o isolamento e o ciclo de vida dos ambientes de trabalho](07-isolation-choice.md).
- [Definir estados, filas, persistência e reconciliação dos efeitos](08-state-and-effects-contract.md).
- [Definir o protocolo de execução e retomada entre controlador e worker](15-controller-worker-protocol.md).
- [Definir o contrato e o perfil distribuível do adapter Gondolin](19-gondolin-adapter-contract.md).
- [PRD — Software Factory MVP](../prd.md): RF-06–07, RF-10, RF-12–14; RNF-01–04; CA-05–07 e CA-11–12.

## Comments

- Graduado da névoa de observabilidade após a definição dos registros, efeitos e resultados ortogonais.
  Sem tecnologia de logs ou formato de artefatos aprovado nesta criação.

- Confirmações HITL nesta sessão: Q1–Q4, “sim às quatro”; Q5–Q9, “de acordo”; Q10–Q12 e fechamento do entendimento, “concordo”. As decisões aprovadas estão
  consolidadas exclusivamente no Answer abaixo.
- Uma única decisão não-research resolvida nesta sessão. Nenhuma implementação, coleta de credenciais, remoção de artefatos da fábrica ou prova executada.
- Validação documental: `git diff --check`, metadados/status/dependências dos 22 tickets, ausência de ciclos, índice de resoluções e links locais dos três
  arquivos alterados. Provas de runtime permanecem futuras; não há alegação de homologação.

## Answer

### Escolha e limites

Reaproveitar a autoridade Pi Durable/SQLite para histórico e resumos, arquivos JSONL para logs detalhados e o formato nativo Pi para sessões. Não adicionar
banco, serviço de logs, event sourcing, diário paralelo, serviço de billing ou sistema genérico de inspeção de dados. A escolha reduz componentes operacionais
sem confundir logs ou sessões com autoridade de controle.

A CLI consulta o controlador proprietário pelo transporte já aprovado; não escreve diretamente no storage nem reconstrói autorização, fila, contadores ou
resultado a partir de logs. São distintos: decisão persistida, progresso observado, resultado de ferramenta, efeito externo confirmado e cessação comprovada. Um
não substitui os demais.

O contrato fecha desenho, não comprova a integração de persistência/filtragem no SDK fixado. Reaproveitar seus mecanismos quando cumprirem o contrato;
incompatibilidade encontrada na implementação/prova exige correção compatível ou retorno ao operador, nunca relaxamento silencioso.

### Registros, correlação e localização

Manter os registros já definidos no [contrato de estados e efeitos](08-state-and-effects-contract.md). O histórico guarda transições/comandos, origem/autor,
motivo, antes/depois relevante e referências de evidências. O resumo mantém identidades, resultado, impedimentos, tentativas, referências, revisões e decisões
suficientes para explicar o Trabalho sem depender da sobrevivência de todos os logs.

Sob a raiz privada da instalação:

| Área | Conteúdo e ciclo de vida |
| --- | --- |
| `records/<work_id>/sessions/` | Sessões no formato nativo do runtime, identificadas por sessão e papel; a mesma sessão pode atravessar Execuções |
| `records/<work_id>/logs/` | Logs JSONL e arquivos de saída de ferramentas, correlacionados à Execução/worker; sujeitos à retenção de detalhes |
| `records/<work_id>/evidence/` | Fontes versionadas, pareceres, resultados de validação e recibos necessários, referenciados pelos registros existentes; conservar o que sustenta histórico, decisões e recuperação |

Essas áreas não são montadas no guest. O contexto necessário aos agentes permanece na área própria aprovada pelo adapter; antes de removê-la, preservar as
evidências que precisam sobreviver ao cleanup. Não introduzir coletor de páginas/documentos no controlador nem permitir que a cópia local substitua a identidade
de conteúdo/spec. Fontes continuam sendo obtidas pelo Builder conforme o contrato de captura versionada. Paths absolutos, disposição dos ambientes e instalação
pertencem ao [contrato operacional](21-installation-operations-contract.md).

Os registros estruturados da fábrica carregam versão de formato, identidade, origem/papel, horário, tipo de evento e correlações pertinentes: Trabalho,
Execução, worker, sessão, tentativa, rodada, pergunta, efeito e referências do ambiente/boot. Reutilizar IDs e envelope existentes; não inventar outro conjunto
de identidades nem exigir todos os campos para eventos globais. Sessões mantêm seu formato nativo, com vínculos pelos registros da fábrica.

| Evidência | Informação necessária |
| --- | --- |
| Ativação/modelo | Execução, papel, worker/sessão, modelo/provider e perfil/configuração efetiva sem segredos; versões de runtime/skills e substituição de sessão com motivo |
| Ferramenta/comando | Identidade da chamada, comando/argumentos filtrados, contexto/cwd permitido, início, conclusão/falha/aborto/resultado desconhecido e referência da saída; status/exit code apenas quando observado |
| Revisão/validação | Rodada, papel, conteúdo/spec correlacionados, conclusão/falha, achados e tratamento pelo Builder, gates executados/dispensados/não executados e evidências previstas no contrato de revisão |
| Pergunta/efeito | IDs existentes, origem, publicação/observações/recibos e resposta autorizada; envio não equivale a efeito confirmado |
| Recursos/cleanup | Trabalho e identidade própria do recurso, tipo/referência/localização, evidência de propriedade, remoção pendente/concluída/falha/indeterminada e motivo |

Registros normais das ferramentas continuam preservando a expectativa remota efetivamente usada no lease. Não acrescentar parser de shell, wrapper Git/gh ou
intenção obrigatória antes de cada push/PR. Evidência perdida permanece lacuna a reconciliar, conforme o [protocolo
controlador–worker](15-controller-worker-protocol.md).

### Duração, atividade, uso e custo

Exibir duração ativa separada de espera e última atividade. Reutilizar medição monotônica e regras de incerteza do protocolo, mantendo horários de calendário
para apresentação; não somar relógios de origens diferentes como duração exata. Silêncio não prova travamento e atividade não prova progresso útil. Falhas e
abortos também aparecem no histórico.

Uso/custo são apresentados por Execução e papel e agregados por Trabalho e instalação, incluindo Builder, Standards e Spec e tentativas falhas quando
mensuráveis. A agregação respeita a identidade de origem para não cobrar novamente o mesmo registro recebido/reconciliado ou somar duas vezes totais de uma
sessão retomada.

Distinguir medição completa, parcial e indisponível. Valor zero só significa zero observado. Se parte do uso se perdeu, apresentar total conhecido com lacunas,
não total completo. Custo calculado pelo SDK é estimativa, com modelo/provider e unidade/moeda quando disponíveis, não fatura. Não exigir consulta a billing nem
inventar preços para completar dados ausentes. Após exclusão explícita de histórico, não apresentar o agregado remanescente como consumo integral de toda a vida
da instalação.

Consumo de recursos do ambiente, quando disponível pelo adapter, permanece distinguível de uso do modelo e custo estimado. Indisponibilidade não é zero; uso
físico, capacidade virtual e espaço livre não são a mesma medida. Não exigir acesso ao raciocínio interno dos modelos.

### Superfície de inspeção

Oferecer saída humana e JSON, sem sistema genérico de consultas:

- **Global:** pausa, ocupação de Slots, filas/categorias, impedimentos, falhas de cleanup e consumo conhecido.
- **Trabalho:** resultado e autorização; motivo da espera/bloqueio e ação necessária; Execuções/tentativas, duração/última atividade; perguntas, revisões,
  validações, PR e efeitos pendentes; recursos preservados, consumo e referências aos logs/evidências.
- **Histórico/logs:** paginação e filtros por Execução/papel; navegar do resumo à evidência, sem despejar sessões inteiras por padrão.

Observações externas indicam quando foram obtidas. Falha de consulta ou dado desatualizado não aparece como situação atual confirmada. Arquivo ausente,
expirado, removido explicitamente ou captura incompleta deve ser explicado, não convertido em lista vazia que sugira ausência de atividade. A sintaxe dos
comandos e o comportamento quando o controlador estiver indisponível pertencem ao contrato operacional.

### Saídas volumosas e falhas de gravação

Saídas textuais grandes seguem para arquivos próprios, com filtragem antes da gravação; CLI e sessão recebem trecho explicitamente marcado e referência para
leitura paginada. Reutilizar os mecanismos do runtime quando cumprirem esse contrato, sem duplicar arquivos/formatos desnecessariamente. Não acumular a saída
inteira em memória; limites de captura, quando atingidos, ficam explícitos. Não apagar arquivos anteriores para liberar espaço.

Conforme aprovação na [revisão cruzada](23-architecture-cross-review.md), a referência entregue ao agente deve ser legível no seu perfil:
disponibilizar seletivamente a saída já filtrada necessária ao papel na área de artefatos do próprio Trabalho exposta pelo adapter,
fora das alterações destinadas ao PR. Usar leitura/paginação existentes, sem montar `data/records`, fallback de leitura host ou nova
ferramenta de logs. Preservar separadamente a evidência protegida sob `data/records` conforme retenção; a cópia acessível ao Builder
não é autoridade do resultado da ferramenta nem pode fabricar sucesso de gate. Ausência, captura parcial ou falha na disponibilização
são explícitas e impedem conclusões dependentes de conteúdo faltante. Não expor sessões, segredos ou registros de outros Trabalhos.

Distinguir:

1. **Exibição truncada:** íntegra disponível por referência.
2. **Captura incompleta:** bytes/parte da saída não foram preservados; a referência não promete íntegra.
3. **Resultado desconhecido:** falta evidência suficiente da conclusão.

Recortar exibição não invalida por si um resultado conhecido, mas captura parcial não autoriza inferir aprovação que dependa do conteúdo ausente. Revisão sem
contexto suficiente continua incompleta. Execução de comando, resultado e saída são fatos distintos.

Perda de amostra auxiliar de progresso/consumo gera lacuna visível sem interrupção obrigatória. Impossibilidade de persistir controle, contexto de retomada ou
resultado necessário impede novos passos dependentes e solicita parada supervisionada quando houver atividade afetada. Se o próprio storage estiver
indisponível, não alegar que o erro já foi persistido; diagnóstico e reconciliação posterior devem refletir essa limitação. Pedir parada não prova cessação.

Exemplo: perder a saída necessária de um teste não o torna verde porque o processo aparentemente terminou. Recuperar evidência ou executar nova validação
autorizada; não repetir comando com efeitos automaticamente em resposta a falha de gravação. Falha de filtragem também não autoriza liberar o conteúdo bruto por
um caminho alternativo.

### Segredos, acesso e limites

Não registrar ambiente secreto, payload de autenticação, chave emissora ou valor de token em prompt, argumentos, logs, recibos ou sessões. Reutilizar entrega de
credencial por ambiente explícito e metadados sem segredo do [contrato da GitHub App](11-github-app-contract.md). Não criar cofre para recuperar tokens perdidos
após crash.

Filtrar segredos conhecidos fornecidos pela fábrica antes de alimentar sessões, gravar saídas/registros ou exibir/publicar conteúdo nos caminhos controlados,
inclusive streaming. A filtragem precisa preceder tanto a persistência nativa do SDK quanto outros destinos de saída; filtrar apenas a CLI ou o arquivo final
não atende ao contrato. Fragmentação de um valor entre chunks não pode contornar a filtragem do valor conhecido. Não encaminhar ambiente inteiro nem usar modo
de diagnóstico que despeje segredos.

Manter diretórios e arquivos privados da conta da instalação, dedicada recomendada ou pessoal conforme o [contrato operacional](21-installation-operations-contract.md#alcance-e-instalação-autocontida). Controlador, adapter e workers host continuam na base confiável; processos dessa conta e
administração do host não ficam isolados por mera separação de diretórios. Sessões e evidências podem conter conteúdo sensível do repositório mesmo sem
credenciais.

Não prometer detecção universal: código no guest pode copiar ou transformar token legitimamente recebido; arquivos arbitrários não são automaticamente saneados,
e um valor perdido após crash não é magicamente recuperável para filtragem por correspondência. Reutilizar o risco residual já aceito, sem alegar
revogação/remoção de cópias externas. Não afirmar que preservação de fontes versionadas equivale a certificação de ausência de segredos.

Não publicar logs/sessões automaticamente no GitHub. Perguntas e marcos relevantes seguem os caminhos já aprovados com filtragem; não criar auditoria exaustiva
de CI nem exigir raciocínio interno.

### Retenção e limpeza

| Classe/condição | Política aprovada |
| --- | --- |
| Trabalho não entregue: aberto, bloqueado, cancelado ou PR fechado sem merge | Preservar integralmente artefatos até limpeza explícita; nenhuma expiração automática de logs/sessões |
| Ambiente/recursos próprios de Trabalho entregue | Cleanup automático após merge e cessação confirmados, sem esperar o prazo de logs/sessões |
| Logs/sessões de Trabalho entregue | Elegíveis por padrão 30 dias após confirmação do merge, com prazo configurável |
| Evidência necessária a cleanup/efeito indeterminado | Preservar enquanto houver pendência, mesmo após o prazo |
| Resumo, histórico, referências, revisões e decisões | Manter até exclusão explícita; remoção do ambiente não os apaga |

O controlador executa retenção na inicialização após reconciliação e depois uma vez ao dia; não adicionar daemon. Antes de cada remoção, revalidar entrega,
prazo, propriedade e ausência de uso ou necessidade de recuperação. Não remover arquivo ainda em uso. Terminada uma pendência protetora após o prazo, os
detalhes tornam-se elegíveis na próxima varredura, sem reiniciar mais 30 dias. O histórico durável de sua resolução permanece.

Referências não substituem conteúdo que ainda deva ser preservado: antes do cleanup, manter fora da área removível fontes, pareceres, resultados e demais
evidências necessárias aos registros retidos. Não apagar a única cópia de uma decisão/revisão junto com um log expirado. É classificação pelos registros
existentes, não um segundo sistema de arquivamento.

Manter inventário de recursos próprios e resultados individuais de remoção, reaproveitando intenções de cleanup existentes. Remoção de ambiente usa a interface
do adapter e suas referências opacas; controlador não interpreta flags QEMU ou recursos internos do backend. Branch-base, recursos desconhecidos/de outros
Trabalhos e limpeza global Docker permanecem proibidos.

Falha parcial fica visível, não desfaz entrega e pode ser tentada novamente. Repetição considera somente pendentes e confirma estado/propriedade; falha de
consulta não equivale a recurso ausente. Recursos já removidos não autorizam declarar todos os demais removidos. O crescimento de disco em não entregues é
aceito e informado, sem exclusão automática para liberar espaço.

### Limpeza explícita, exclusão do histórico e cópias externas

**Limpar recursos** exige seleção explícita, apresentação do que será perdido, propriedade confirmada e ausência de atividade capaz de escrever. Preservar
evidências de reconciliação pendente. Trabalho ainda em aberto exige cancelamento prévio para destruir ambiente ou contexto de retomada; cleanup não cancela
implicitamente. Ambiente pode ser removido mantendo registros; logs/sessões exigem seleção própria e aviso quando sua perda inviabilizar a retomada existente.
Não fechar PR, reverter efeito externo nem apagar branch alheia.

**Excluir histórico** é operação separada, para Trabalho encerrado e sem recursos/efeitos pendentes. Remove resumos, conteúdo de decisões e evidências
selecionadas, preservando registro mínimo para impedir reentrada automática e sustentar a avaliação de dependências próprias.
Conforme aprovação na [revisão cruzada](23-architecture-cross-review.md), conservar identidades de Ticket/repositório/Trabalho,
ordem/vínculo do ciclo, resultado e, quando entregue, identidade/referência do PR e fato de merge confirmado.
Não conservar nessa memória logs, pareceres ou conteúdo do pedido. Excluir histórico não transforma Ticket próprio em externo:
último ciclo entregue permanece comprovável; cancelado não satisfaz dependência e novo ciclo explícito passa a ser o avaliado,
conforme o [contrato de dependências](09-dependency-compatibility.md#enumeração-grafo-e-satisfação).
Novo Trabalho continua exigindo comando explícito. Explicar que isso não apaga toda referência ao Ticket nem concede nova autorização.

PR fechado sem merge não basta para excluir histórico: seu ciclo ainda pode ser retomado explicitamente. Exigir cancelamento antes dessa exclusão, sem impedir a
limpeza seletiva autorizada. Recursos já removidos/contexto perdido não são recriados por uma simples retomada presumida.

**Cópias externas:** o encaminhamento original de suporte a backup/restauração foi superado pela revisão de escopo aprovada no
[contrato operacional](21-installation-operations-contract.md#atualização-e-limite-de-recuperação). Seus limites de privacidade continuam válidos:
filtragem de logs não prova saneamento de workspace/disco/cópia; exclusão local não apaga cópias anteriores, que podem recuperar dados excluídos.
Cópias não desfazem GitHub nem dispensam reconciliação. Não prometer que copiar SQLite cobre todos os artefatos ou que a fábrica certifica tais cópias.

### Cenários e critérios de prova futuros

| Cenário | Resultado verificável / cobertura |
| --- | --- |
| Implementação, dois reviews, pergunta/retomada e reparo | Navegar pela CLI de Trabalho/Execução/papel até comandos, resultados, pergunta/resposta, versões e pareceres; sessão retomada não duplica uso; histórico explica autorização — RF-06–07/10/12, RNF-03, CA-01/05/12 |
| Falha/aborto de modelo ou perda de medição | Uso conhecido de todos os papéis preservado, parcial/indisponível explícitos; estimativa não apresentada como fatura nem zero; sem exigir raciocínio interno — RNF-03 |
| Tempo e observações externas | Espera separada de atividade, duração incerta não vira exata/zero, última atividade não vira watchdog; estado GitHub antigo/consulta falha identificados — RF-13, RNF-04, CA-11 |
| Saída grande, truncamento e disco cheio | Memória não cresce com saída integral; agente pagina somente a saída filtrada disponibilizada na sua área; cópia editável não certifica gate nem expõe registros host; captura parcial/resultado desconhecido visíveis; falha crítica impede passos dependentes sem replay cego — RF-07/13, CA-06/12 |
| Segredo sintético em saída, erro e chunks separados | Valor conhecido ausente de logs, arquivos de saída, sessão persistida, exibição e publicação controlada; conferir persistência nativa antes de declarar conformidade; arquivos arbitrários/valores transformados permanecem limite explícito — RF-14, RNF-02–03 |
| Acesso local e guest | Registros privados não montados no guest; conta não autorizada não lê arquivos; sem alegar proteção contra conta confiável/administração host — RNF-02 |
| Trabalho não entregue por mais de 30 dias | Logs, sessões e contexto intactos, inclusive bloqueado/cancelado/PR fechado; consumo de disco visível; nenhuma exclusão para abrir espaço — RF-14, CA-05/07 |
| Entregue, cleanup e expiração | Ambiente removível somente após cessação; evidências transferidas/preservadas antes; logs/sessões elegíveis no prazo, histórico/revisões/decisões continuam acessíveis — RF-14, CA-01/07 |
| Pendência além do prazo e corrida com uso do arquivo | Evidência protegida enquanto necessária/em uso; após liberação e prazo vencido, elegível na próxima varredura sem novo prazo; falha individual repetível — RF-14, CA-06/07 |
| Cleanup parcial e propriedade incerta | Resultado entregue permanece; repetir somente pendentes próprios, não remover base/outros Trabalhos/recursos globais; falha de consulta não é ausência — RF-14, CA-07 |
| Limpeza seletiva e exclusão de histórico | Aviso de perdas, cessação e seleção; exigências de cancelamento respeitadas; memória mínima evita redisparo e preserva dependência própria entregue/cancelada/novo ciclo após exclusão — RF-01/02/11–14, CA-02/07/10 |
| Limite documental de cópias externas | Explicitar possível reaparecimento de dados e ausência de rollback do GitHub; não implica funcionalidade ou prova de restauração integrada, retirada pelo contrato operacional |

Essas provas exigem autorização posterior; os cenários de segredos usam valores sintéticos, não credenciais reais. Nenhuma prova foi executada nesta decisão e
documentação não demonstra ausência de vazamentos, durabilidade ou recovery da composição.

### Encaminhamentos

[Definir a configuração, a CLI e o ciclo operacional da instalação](21-installation-operations-contract.md) concretiza raiz/paths absolutos, distribuição,
configuração do prazo, sintaxe dos comandos e indisponibilidade do controlador, consumindo este contrato sem novo backend ou política de retenção implícita.
O encaminhamento original de backup/expiração/restauração foi retirado por revisão HITL explícita naquele ticket; a recuperação após crash permanece obrigatória.

A cobertura consolidada de aceite e a revisão cruzada da arquitetura permanecem na névoa do mapa até a composição com o contrato operacional. Não surgiu nova
decisão autônoma nesta resolução; não abrir tickets de implementação nem antecipar spec integral ou pilotos.
