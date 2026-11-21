# Spec da v2 — sandbox Lambda MicroVMs

Status: aprovada pelo Operador em 2026-11-21.
Fonte: [Consolidar o PRD e a spec da v2 para o sandbox Lambda MicroVMs](issues/03-revised-sandbox-contract.md#answer).

## 1. Autoridade e alcance

Este documento descreve só as **diferenças** da v2 frente ao MVP. O [PRD](../software-factory/prd.md),
a [spec](../software-factory/spec.md) e as [interfaces públicas](../software-factory/module-public-interfaces.md)
do MVP continuam valendo sem alteração; o que não aparece aqui segue o MVP. A tabela da seção 12 diz, por
seção do MVP, o que muda no perfil Lambda.

A v2 acrescenta um segundo adapter de sandbox: ambientes reconstruíveis em AWS Lambda MicroVMs. O
harness é o do MVP. Uma instalação de um Operador, na própria conta AWS; sem SaaS, multi-tenant, HA
ou EC2 administrada.

Cada requisito traz a origem da sua sustentação:

- **provado**: observado em protótipo, no perfil testado, com o critério da rubrica citado
  ([infraestrutura](research/lambda-proof-results.md), [continuidade](research/agent-continuity-results.md));
- **decidido**: decisão do Operador sem prova própria, a validar na implementação;
- **não provado**: depende de gate da seção 11 ou de ticket filho.

Aprovar este documento não é aceite da fábrica, homologação de produção nem suporte oficial da AWS:
Docker em Lambda MicroVMs continua sem menção na documentação do serviço.

## 2. Vocabulário

Usa o vocabulário do PRD. Termos que a v2 precisa, sem criar glossário global:

| Termo | Sentido |
| --- | --- |
| Boot | Uma ativação do ambiente (uma MicroVM). Não é Trabalho nem Execução. |
| Troca planejada | Encerrar um boot e iniciar outro dentro da mesma Execução, por limite de duração. |
| Perda | Morte do ambiente com trabalho não publicado no `origin`. |
| Gate de preservação | Verificação, no guest, de que o trabalho está publicado no `origin`. |
| Reconstrução | Recriar o ambiente a partir do Git remoto e da declaração de ambiente. |
| Sessão substituta | Sessão nova que retoma o Trabalho depois de uma perda (termo do MVP, §5.5). |

## 3. Seleção e interface

**V2-01 — Um sandbox por instalação (decidido).** A configuração da instalação escolhe estaticamente
Gondolin ou Lambda para todos os repositórios. Sem escolha por repositório ou por Trabalho, seleção
automática, Slots por adapter ou política híbrida.

**V2-02 — Mesmas sete operações (decidido).** Validar, preparar, iniciar, executar ferramenta, observar,
parar e remover continuam sendo a interface. No Lambda:

| Operação | Sentido no perfil Lambda |
| --- | --- |
| Validar | Identidade, região, permissões, quota e recursos de instalação conferidos sem iniciar MicroVM (V2-31). |
| Preparar | Garante a imagem de MicroVM da chave de ambiente (V2-27); repetição reconhecível. |
| Iniciar | `RunMicrovm`, transporte estabelecido, clone do commit de partida no guest. Novo boot, nunca adoção de sobrevivente. |
| Executar ferramenta | Chamada pelo canal SSH sob o papel vinculado pelo host. |
| Observar | Condição pelo serviço (`GetMicrovm`), consumo e evidências; funciona sem o processo que criou o boot. |
| Parar | `TerminateMicrovm` e cessação confirmada pelo serviço. Não preserva disco. |
| Remover | Encerra o que restar, apaga a ref de marcador de perda (V2-16) e registra; não toca branch nem PR. |

**V2-03 — Capacidades declaradas (decidido).** O adapter declara: Docker; disco que sobrevive ao boot;
duração máxima do boot e margem de rotação; propriedades de saída de rede. O Controle lê capacidades,
nunca detalhes do serviço. "Parar preserva disco/workspace" deixa de ser contrato universal e passa a
ser consequência da capacidade de disco persistente, que o Gondolin declara e o Lambda não.

**V2-04 — Capacidade ausente é diagnóstico (decidido).** Capacidade exigida pelo repositório e não
declarada pelo adapter impede o início com diagnóstico; nunca há fallback para outro sandbox.

Perfil Lambda declarado: Docker sim (provado: D1 a D5); disco persistente não; duração e margem conforme
V2-12; saída conforme V2-25.

## 4. Preservação no Git remoto

**V2-05 — Onde o gate vale (decidido).** O gate de preservação é exigido quando o adapter não declara
disco persistente. O comportamento do Gondolin fica como no MVP. No Lambda o gate precede:

1. toda devolução de controle com espera externa (Pergunta ao humano, espera de CI, prontidão);
2. a troca planejada de boot;
3. o fim de toda ativação da sessão substituta.

Implementação, revisões internas, tratamento de achados e push cabem normalmente no mesmo boot, sem
checkpoint entre Builder e revisores.

**V2-06 — O que o gate verifica (provado: G1).** No guest: workspace limpo, incluindo untracked não
ignorados; ausência de stash; `HEAD` igual à ponta da branch do Trabalho consultada no `origin`
(`ls-remote`), sem confiar na ref de acompanhamento local. Workspace sujo, stash, commit sem push,
remoto indisponível ou não confirmado nunca equivalem a preservação concluída.

**V2-07 — Recusa do gate (decidido).** A recusa volta ao Builder com o motivo, para correção. O gate é
imposto pelo Controle, não confiado ao prompt (provado como necessidade: continuidade, achado 5). Três
recusas seguidas na mesma devolução geram Bloqueio com o diagnóstico da última; o ambiente continua
sujeito à rotação, e se morrer sem publicação vale o caminho de perda. O Builder pode publicar WIP,
mesmo antes de existir PR. O procedimento não autoriza versionar segredos ou dados impróprios: se não
for possível publicar com segurança, o Builder reporta o impedimento em vez de forçar o commit.

**V2-08 — Sem outro mecanismo de checkpoint (decidido).** A retomada parte do Git remoto. Sem S3, git
bundle ou cópia do workspace no host. Arquivos ignorados, pacotes, caches e dados do Docker são
reconstruíveis por definição.

## 5. Esperas, boots e rotação

**V2-09 — Espera externa encerra o ambiente (decidido).** Depois do gate aceito, a MicroVM é encerrada,
não suspensa, e a cessação confirmada pelo serviço precede a liberação do Slot (provado o mecanismo: L1).
A suspensão automática por ociosidade fica desligada no perfil, porque o serviço mede ociosidade por
tráfego de entrada. Suspend/resume não faz parte da v2.

**V2-10 — Identidade (decidido).** A troca planejada mantém Trabalho, Execução, Slot, relógio de timeout
e sessão; muda só a referência de boot e não consome retomada operacional. A perda encerra a Execução:
a sessão substituta entra pela fila como nova Execução e consome uma retomada operacional do orçamento
existente. Cada boot é registrado com motivo: início, troca planejada, perda ou fim (provado: I1).

**V2-11 — Continuidade compatível e aviso (provado em parte: R2, P3).** Toda ativação em um boot
diferente do último que a sessão viu começa com um aviso fixo do Controle: ambiente recriado, commit de
partida, e que arquivos ignorados, caches e dados do Docker não existem mais. A mesma sessão continua
quando a ponta da branch no `origin` é o commit confirmado pelo gate ou descende dele; o aviso lista os
commits novos. Histórico reescrito ou branch ausente segue a regra de divergência do MVP (§10.1).
Não provado: retomada com commits de terceiros.

**V2-12 — Duração e margem (decidido; valores acima de 3600 s não provados).** Padrão de 3600 s de
duração máxima do boot (provado: L2) e 600 s de margem, configuráveis no perfil do adapter. Valor acima
de 3600 s é aceito e marcado como não provado até o gate de boot longo.

**V2-13 — Sequência da troca (provado em parte: G3, R1).** Ao cruzar a margem, o Controle não
interrompe a chamada em curso. Quando ela retorna, entrega o aviso de troca como ativação própria: o
Builder publica o WIP, o gate aceita, a cessação é confirmada e só então outro boot é iniciado. Se a
chamada não retornar até restar metade da margem, o adapter a interrompe e pede o WIP com o tempo que
sobra. Se o gate não aceitar antes do fim do boot, vale o caminho de perda. Não provado: troca sob
pressão real da margem e chamada interrompida.

**V2-14 — Limite contra laço (decidido).** Dois boots seguidos do mesmo Trabalho encerrados sem nenhum
commit novo publicado entre eles geram Bloqueio com o diagnóstico "sem progresso entre boots", em vez
de um terceiro boot. Cobre a chamada indivisível maior que o boot.

**V2-15 — Morte do ambiente encerra a ativação (decidido; a prova reprovou a ausência disto: I2).**
O adapter observa a condição do ambiente pelo serviço em intervalo declarado, haja ou não chamada em
curso. Cessação confirmada cancela a chamada em voo, nega novas chamadas e faz o Controle encerrar a
ativação. Silêncio do agente ou comando longo continuam não sendo motivo de parada: observa-se o
ambiente, não o trabalho.

**V2-16 — Hook de término como melhor esforço (provado o mecanismo: G4).** O hook de término empurra o
`HEAD` commitado para `refs/factory/lost/<trabalho>/<boot>`. Isso nunca conta como preservação nem
satisfaz o gate. O hook não aceita parâmetros do chamador. Não cobre arquivos sem commit, push lento,
remoto indisponível ou falha do próprio serviço.

## 6. Perda e sessão substituta

**V2-17 — Perda aceita e visível (provado: G4, P1).** Se o ambiente morre antes da publicação, perde-se
o trabalho local desde o último push, com ocorrência e consumo registrados. A sessão antiga é
conservada como evidência.

**V2-18 — Pacote da substituta (provado: P3).** A substituta recebe instrução explícita de recuperação
com Trabalho, Execução, boots com motivo, último commit confirmado, a perda declarada, os efeitos de
resultado incerto registrados pelo Controle, o consumo acumulado e a ref de marcador de perda, se
existir, para aproveitar em vez de refazer. Sem transcript nem resumo da sessão anterior.

**V2-19 — Conduta da substituta (decidido; a prova reprovou a ausência disto: P2).** A substituta:

1. nunca repete um efeito de resultado incerto (provado: E1);
2. conclui o que não depende dele;
3. se o restante depende, abre uma Pergunta descrevendo o efeito e o registro do Controle; a resposta
   autoriza repetir ou dar por feito;
4. publica o que fez antes de devolver o controle, por força do gate (V2-05).

A reconciliação é uma Pergunta comum do MVP, sem mecanismo novo.

## 7. Transporte

**V2-20 — SSH sobre WebSocket pelo `HTTP_INGRESS` (provado: T1 a T3, N2).** Comandos e arquivos passam
por SSH transportado em WebSocket, com componentes prontos. Autenticação em duas camadas: token do
serviço por porta e chave SSH de sessão. Autenticar o túnel não autoriza operações: o papel é vinculado
pelo host a cada chamada. `SHELL_INGRESS` e servidor exec próprio não são usados.

**V2-21 — Canal caído com ambiente vivo (decidido; comportamento do processo provado: T4).** Queda do
canal sozinha não encerra a ativação. O adapter consulta o serviço; com o ambiente ativo, reconecta,
encerra o grupo de processos da chamada órfã e devolve à sessão o resultado "indeterminado", nunca "não
executada". Não há reanexação à saída do processo órfão.

**V2-22 — Retirada de acesso (provado: T4).** Token vencido não derruba conexão aberta. Retirar acesso
significa fechar a conexão ou encerrar a MicroVM. O adapter mantém keepalive; ociosidade sem keepalive
e conexões além de 38 minutos não foram medidas.

## 8. Papéis, credenciais e rede

**V2-23 — Revisores (provado em parte: T5, T6).** Vale a restrição do MVP: revisores só têm a ferramenta
`read`, sem shell. No guest, o revisor é um usuário Unix somente leitura, sem grupo `docker` e sem
forwarding, como segunda camada. Risco residual documentado: esse usuário alcança portas locais do
guest por loopback, mas não tem ferramenta que abra conexões. O guest de produção não tem porta de
diagnóstico. Não provado: revisores reais do harness no Lambda.

**V2-24 — Credenciais (decidido, sobre o MVP §8).** O token reduzido do Builder segue o MVP: em memória,
entregue por comando em ambiente explícito pelo canal, nunca gravado no guest, sem deploy key. A chave
emissora da GitHub App nunca vai ao guest. Credenciais do transporte: chave SSH de sessão por boot,
gerada no host e entregue no payload do hook de início; host key gerada no boot e fixada pelo host;
token do serviço por porta. Credenciais AWS ficam só no host; o guest roda sem execution role e o IMDS
não entrega credenciais (provado: N1). Limite: o Builder com Docker lê qualquer arquivo do guest
(provado: T6), então nada que o Builder não possa ver é colocado lá.

**V2-25 — Saída de rede: relaxamento aprovado (provado: N1, D4).** Com `INTERNET_EGRESS`, qualquer
destino público IPv4 por TCP fica acessível, sem mediação nem filtro de destinos. UDP e IPv6 de saída
não existem. O ambiente não alcança a rede privada do Operador por estar fora dela, não por filtro.
Frente ao MVP, perde-se a mediação HTTP(S). VPC para exceções privadas fica fora da v2.

**V2-26 — Fronteira de confiança (decidido).** Controlador, workers, sessões e SQLite continuam no host
e são confiáveis. O guest inteiro é não confiável para o Controle: nada lido dele decide autorização.
Como no MVP, a instalação não é plataforma para código adversarial.

## 9. Ambiente por repositório

**V2-27 — Mesma declaração, imagem por chave (decidido; não provado).** O `.factory/environment.yaml`
do MVP vale sem mudança de esquema. O adapter constrói uma imagem de MicroVM por (repositório, hash do
arquivo, pin da release) com um `Dockerfile` fixo montado pelo host a partir dos valores validados,
partindo de Alpine, sem comandos livres. Trabalhos com a mesma chave reutilizam a imagem. Falha de
build é impedimento visível com causa, sem fallback de imagem ou versão. Guest Alpine com Docker em
Lambda não foi provado (a prova usou Amazon Linux 2023): depende do ticket
[Validar o guest Alpine com o ambiente declarado em Lambda MicroVMs](issues/10-alpine-guest-on-lambda-proof.md).
Se a prova falhar, a decisão volta ao Operador.

**V2-28 — Estado do boot (provado: L3, D1, G2).** Nenhum processo vem do snapshot: `dockerd`, `sshd` e
a host key nascem no hook de início. As imagens Docker declaradas são baixadas por digest a cada boot;
embuti-las na imagem de MicroVM fica não especificado. Cada boot começa sem caches e sem dados do Docker.

## 10. Instalação, capacidade, consumo e cleanup

**V2-29 — Perfil encapsulado (decidido).** Região, arquitetura, tamanho, duração, margem e intervalo de
observação ficam no perfil do adapter, fora do Controle. Perfil de aceite: `us-east-1`, ARM64, baseline
de 1 GB / 0,5 vCPU com pico de 4 GB / 2 vCPU, `additionalOsCapabilities: ["ALL"]`. O guest enxerga o
pico; o disco observado é de 8 GB.

**V2-30 — Quota e concorrência (decidido; quota provada: achado 2).** O Operador configura a
concorrência de Builders já existente. A quota observada é de 8 GB de memória alocada, duas MicroVMs do
perfil de aceite. `validate` diagnostica quando concorrência × tamanho excede a quota lida da conta,
sem ajuste automático. Recusa do serviço por quota em execução é impedimento visível do início e não
consome retomada operacional.

**V2-31 — Instalação (decidido).** A release traz um template que o Operador aplica na própria conta
para criar a role de operação com política mínima, a role de build e o bucket de artefatos de build.
A Factory nunca cria IAM. Ela usa um perfil AWS nomeado na configuração, sem guardar credenciais.
Limite conhecido: `CreateMicrovmImage` e `TagResource` não aceitam restrição por recurso, então a
política tem essas ações em `*`, a segunda condicionada à tag da instalação.

**V2-32 — Consumo (decidido).** Por boot: identidade, motivo, tamanho, início, fim e segundos, a partir
de `GetMicrovm`; builds de imagem por chave. Por Trabalho: MicroVM-segundos acumulados, sem reinício
entre boots ou Execuções. A Factory não calcula valor em dólares nem aplica teto em dólares: os limites
são as retomadas operacionais, o timeout por Execução e V2-14. O Operador confere o custo pela tag da
instalação.

**V2-33 — Tags, reconciliação e cleanup (decidido).** Todo recurso AWS criado pela Factory leva tags de
instalação e de Trabalho. Depois de crash, a Factory inventaria por tag e encerra MicroVMs sem
proprietário vivo. Imagens de MicroVM ficam enquanto houver Trabalho aberto com a chave e saem só por
cleanup explícito.

**V2-34 — Evidência do guest (decidido).** Sem execution role não há logs de runtime, e Run/Terminate
não aparecem no CloudTrail por padrão: a evidência de ciclo de vida é a de `GetMicrovm`, e a do guest é
a que o host coleta pelo canal. O que não foi coletado antes de uma morte é declarado perdido.

## 11. Matriz de aceite

O aceite da v2 é: os critérios de aceite do MVP (PRD §8, spec §13.2) reexecutados no perfil Lambda com
um repositório real, mais os gates abaixo. Homologação de produção é decisão separada do Operador,
depois do aceite.

| Requisito | Provado no protótipo | Gate de validação da implementação | Não coberto |
| --- | --- | --- | --- |
| V2-03, V2-04 | Docker: D1 a D5 | Repositório que exige capacidade ausente recebe diagnóstico | — |
| V2-05 a V2-07 | G1 (seis casos sujos, sem agente) | Gate recusando com agente real; três recusas geram Bloqueio | Push lento |
| V2-09 | L1 | Espera humana e de CI encerram a MicroVM antes de liberar o Slot | — |
| V2-10, V2-11 | R2, I1, P3 | Mesma sessão após troca; retomada com commits de terceiros | Sessões longas, compactação |
| V2-12, V2-13 | L2 (até 3600 s), G3, R1 | Troca sob margem real; chamada interrompida na metade da margem; **boot acima de uma hora** | Oito horas, carga sustentada |
| V2-14 | — | Dois boots sem commit novo geram Bloqueio | — |
| V2-15 | **Reprovado na prova (I2)** | **Obrigatório:** nenhum pedido de modelo nem chamada depois da cessação confirmada | — |
| V2-16 | G4 | Ref de marcador criada, informada à substituta e removida no cleanup | Hook com remoto indisponível |
| V2-17 a V2-19 | P1, P3, E1; **P2 reprovado** | **Obrigatório:** substituta conclui, publica e pergunta sobre o efeito incerto | Variância do modelo, efeitos em serviços reais |
| V2-20 a V2-22 | T1 a T4, N2 | Canal caído: reconexão, órfão encerrado, resultado indeterminado | Conexão além de 38 min sem medição |
| V2-23 | T5, T6 (usuário Unix) | Revisores reais do harness no Lambda | — |
| V2-24, V2-25 | N1, T6, D4 | Token não persiste no guest; guest sem credenciais AWS | VPC |
| V2-27, V2-28 | L3, D1, G2 (Amazon Linux 2023) | Ambiente declarado de um repositório real | **Guest Alpine: ticket filho** |
| V2-30, V2-31 | Quota observada | `validate` com quota excedida e com permissão faltante | Outras regiões, x86, outros tamanhos |
| V2-32 a V2-34 | I1, C1 | Consumo por boot e por Trabalho; reconciliação encerra órfãs por tag | Cobrança acima do baseline |

Fora da v2 por decisão: suspend/resume, VPC, escolha de sandbox por repositório, teto em dólares.

## 12. Rastreio frente ao MVP

| MVP | No perfil Lambda |
| --- | --- |
| PRD RNF-02 (isolamento, rede) | Relaxado na rede: V2-25. Demais itens inalterados. |
| PRD RF-13 (limites e recuperação) | Inalterado; acrescidos V2-07 e V2-14. |
| Spec §4.3, §4.4 (capacidade, orçamentos) | Inalterados. Troca planejada não consome retomada; perda consome (V2-10). Quota: V2-30. |
| Spec §5.4 (perda de canal e cessação) | Substituído: V2-15, V2-21, V2-22. A regra "sem watchdog sobre trabalho silencioso" permanece. |
| Spec §5.5 (perguntas e retomada) | Inalterado; acrescidos o gate antes da espera (V2-05), o aviso (V2-11) e a conduta da substituta (V2-19). |
| Spec §5.6 (revisão) | Inalterado: revisão interna no mesmo boot. |
| Spec §5.7 (duração e timeout) | Inalterado; a duração do boot é limite distinto do timeout da Execução (V2-12). |
| Spec §7.1, interfaces Q5 | Mesmas operações; "preserva disco/workspace" vira capacidade (V2-02, V2-03). |
| Spec §7.2 (configuração Gondolin) | Não se aplica; perfil próprio (V2-29). |
| Spec §7.3 (processos, filesystem, Git) | Substituído: sem workspace no host, sem cache bare montado; clone no guest a partir do `origin` (V2-02, V2-08). |
| Spec §7.4 (guest, Docker, persistência) | Declaração de ambiente inalterada; disco base substituído por imagem de MicroVM (V2-27); sem persistência entre boots (V2-28). |
| Spec §7.5 (ferramentas e rede) | Ferramentas por papel inalteradas (V2-23); rede relaxada (V2-25). |
| Spec §8 (GitHub App, segredos) | Inalterado; acrescidas as credenciais do transporte (V2-24). |
| Spec §10.1 (lease e divergência) | Inalterado; usado por V2-11. |
| Spec §11 (instalação, configuração, CLI) | Acrescidos V2-01 e V2-31. Sem comando novo de troca de sandbox em operação. |
| Spec §12 (observabilidade, cleanup) | Acrescidos V2-32 a V2-34. |
| Spec §13 (validação) | Acrescida a seção 11 deste documento. |
| Demais seções | Inalteradas. |
