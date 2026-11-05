# Definir a matriz de aceite e a sequência de validação incremental

Status: resolved
Assignee: Samuel Santos (operador), assistido por Pi
Claim context: sessão Pi `01a1a76c-3d8b-75a8-bc33-e0645fc3467b`; branch `plan/software-factory-acceptance`, worktree `/home/sanmoo/dev/github.com/Sanmoo/pkm/.worktrees/software-factory-acceptance`; integração em `main` no checkout `/home/sanmoo/dev/github.com/Sanmoo/pkm`, sem publicação de `main`.
Type: grilling
Label: wayfinder:grilling
Map: [Especificar tecnicamente o MVP da Software Factory](../map.md)
Blocked by: 23

## Question

Quais evidências e etapas futuras demonstrarão o MVP completo, e como organizar sua construção incremental sem tratar documentação ou simulação como aceite real?

Vincular RF-01–14, RNF-01–05 e CA-01–12 aos contratos aprovados, cenários, tipo de evidência necessário e resultado verificável.
Consolidar provas já encaminhadas nos tickets, especialmente crash após efeitos, concorrência, Docker/Testcontainers, filtragem de segredos,
isolamento/read-only, sessões/reviews, controle de autorização, atualização e limpeza. Distinguir evidência documental, simulação e integração real.
Definir critérios de seleção de repositórios-piloto, pré-requisitos e autorizações necessárias, sem escolher/acessar recursos reais por inferência.
Organizar incrementos conceituais e gates de avanço, não tickets de implementação. Backup integrado não vira gate indireto de aceite.

Usar a revisão cruzada para evitar testes de contratos incompatíveis. Lacuna de desenho exige ticket próprio e dependência, não suposição
na matriz. Aprovação do plano não autoriza executar provas, criar credenciais ou iniciar piloto.
Saída: matriz rastreável e sequência de validação aprovadas, com limites de evidência e riscos residuais explícitos.

## Comments

- Graduado após o fechamento do contrato operacional; planejamento/documentação somente, sem autorização de implementação ou provas.
- Na preparação da rodada HITL inicial, após leitura do PRD, da revisão cruzada e dos encaminhamentos de prova, as propostas ainda aguardavam o operador: evidência no menor nível fiel, distinguindo simulação, integração real e piloto; sequência orientada a riscos com provas das fronteiras frágeis antes da expansão; seleção mínima de pilotos por cobertura, sem escolher recursos reais; aceite pela cobertura dos requisitos e avaliação humana, sem metas arbitrárias. A confirmação posterior está registrada abaixo, sem autorização de execução inferida.
- Encaminhamento da [revisão cruzada concluída](23-architecture-cross-review.md#answer): incluir na cobertura os cenários de dependência própria
  após exclusão de histórico, parada administrativa limpa versus crash, paginação de saída filtrada com ferramentas confinadas e fonte privada
  inacessível sem ampliação de credenciais. Usar as regras canônicas ali referenciadas; aquele encaminhamento não aprovava o plano de aceite.
- Operador aprovou explicitamente Q1–Q4 com “sim a todas essas”: níveis fiéis de evidência, sequência orientada a riscos,
  pilotos por cobertura e conclusão sem metas arbitrárias. A aprovação é do plano, não do MVP nem da execução de provas.
- Uma única decisão não-research resolvida nesta sessão. A consolidação da spec permanece aberta para sessão posterior;
  nenhum experimento, instalação, credencial, modelo, piloto ou prova de runtime foi executado.
- Validação documental: 14 RFs, 5 RNFs e 12 CAs sem lacunas/duplicatas na matriz; 17 grupos de cenários; tipos/labels/estados,
  dependências sem ciclos e índice das 24 resoluções nos 25 tickets; 166 links locais/âncoras nos três arquivos da tarefa;
  `git diff --check`. Sondagem LSP dos três Markdown sem erros/avisos, apenas sugestões informacionais do corretor inglês
  sobre texto português. Única fronteira: consolidação da spec; nenhuma spec antecipada criada.
- Claim context identifica branch/worktree de registros desta sessão, removíveis após integração limpa em `main`, sem publicação.

## Answer

### Decisão aprovada

Adotar a [Matriz de aceite e sequência de validação incremental](../acceptance-and-incremental-plan.md) como asset do plano aprovado.
O documento liga RF-01–14, RNF-01–05 e CA-01–12 aos contratos canônicos, cenários/subcasos, tipos de evidência e resultados verificáveis;
contém os gates conceituais e critérios de seleção/autorização futura dos pilotos. Não substitui os Answers de desenho nem é a spec final.

As quatro escolhas confirmadas pelo operador são:

- **Evidência no menor nível fiel:** regras automatizadas com respostas/relógio controlados; integração real nas fronteiras;
  agentes reais para skills/revisão/retomadas; tickets reais e avaliação humana para utilidade. Simulação e documentação não certificam a composição real.
- **Sequência orientada a riscos:** fronteiras frágeis e controle determinístico podem avançar em paralelo; depois jornada completa,
  concorrência/adversidades, operação da release e piloto. Crash, isolamento, filtragem e evidência começam cedo e reaparecem integrados,
  não são deixados para o final.
- **Pilotos por cobertura:** escolher posteriormente o menor conjunto suficiente de repos/tickets reais e ambientes de teste separados,
  sem nomes ou quota arbitrária agora. Demonstrar o escopo de dependências declarado e Docker/Testcontainers sem certificar manualmente cada par de uso.
- **Conclusão sem sucesso presumido:** planejamento fecha com cobertura rastreável e resultados exigidos definidos;
  o MVP só pode ser aceito após provas suficientes e avaliação humana. Não impor taxa de sucesso, custo-alvo ou prazo arbitrários antes do piloto.

### Cobertura e limites

O catálogo do asset incorpora os cortes de persistência/spawn/recibos/push/PR/pergunta, cessação antes de substituto, três Builders com dois
no mesmo repo, Docker/TLS/FUSE, segredos sintéticos antes da persistência SDK, revisores somente leitura, pedido preservado, gates/checks,
lease/feedback, limites/tempo, instalação/atualização e limpeza/retenção. Inclui os quatro ajustes da revisão cruzada: dependência própria
após exclusão, parada administrativa limpa versus crash, saída filtrada paginável sem autoridade da cópia editável e fonte privada sem ampliar credenciais.

Todas essas evidências de funcionamento permanecem **a demonstrar**. Versões/hashes finais e configuração de capacidade pertencem à futura
release testada, não a números inventados para concluir o plano. Boa métrica não dispensa requisito obrigatório;
prova reprovada/inconclusiva bloqueia o gate dependente e a alegação de conformidade, sem exigir repetir testes independentes.
Lacuna de desenho requer ticket próprio/dependência e retorno ao operador, não relaxamento silencioso.

A aprovação não autoriza instalar, criar credenciais, escolher/acessar recursos reais, executar modelos/provas ou iniciar piloto.
Backup/restauração integrado e certificação/monitoramento das barreiras de base/merge da App continuam fora do escopo;
recovery após crash e validação dos controles que a fábrica implementa continuam obrigatórios. Riscos residuais dos contratos permanecem explícitos no asset.

### Encaminhamento

[Consolidar a spec técnica implementável do MVP](25-consolidate-technical-spec.md) fica desbloqueada para próxima sessão,
comporá decisões existentes e este plano, e ainda exige revisão humana antes do encerramento do mapa.
Nenhuma nova decisão ou névoa em escopo foi identificada nesta consolidação do aceite; lacuna futura deve voltar ao tracker.
O mapa permanece aberto; não foram criados tickets de implementação nem uma spec antecipada.
