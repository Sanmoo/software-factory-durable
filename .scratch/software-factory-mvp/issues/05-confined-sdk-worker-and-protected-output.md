# 05: Executar um worker SDK com ferramentas confinadas e saída protegida

**What to build:** Uma ativação de teste usa Pi SDK real com perfil da Factory, executa ferramenta somente no guest e deixa recibo/resultado protegido consultável. Falha de canal, filtragem ou persistência necessária impede atividade insegura.

**Blocked by:** [02: Operar um controlador exclusivo com pausa durável](02-exclusive-controller-and-durable-pause.md); [03: Preparar, iniciar e parar um ambiente persistente por Trabalho](03-persistent-work-environment.md)

**Status:** needs-info

## Acceptance criteria

- [x] SDK embutido em worker Node recebe modelo/provider, loader, ferramentas, skills e sessões explícitos; não herda recursos pessoais nem executáveis do repo no host e desabilita retries SDK/provider conforme contrato.
- [x] Reserva/autorização antecedem ativação; recibo completo com identidades/perfil/tempo é sincronizado e publicado atomicamente antes de modelo/ferramenta, fora da área editável pelo guest.
- [x] Conexão é vinculada pelo host a invocação/papel/ambiente/boot esperados; mensagens antigas, identidade autoafirmada e operação administrativa de worker não autorizam efeitos.
- [x] Builder usa projeção de ferramentas do adapter da instância existente, sem shell host, SDK Gondolin irrestrito ou ambiente inteiro do host.
- [x] Saídas são filtradas antes de SDK/sessão nativa, arquivo, exibição e streaming, inclusive segredo sintético partido entre chunks; falha não libera bruto por caminho alternativo.
- [x] Saída volumosa é gravada incrementalmente com trecho marcado e referência paginável; cópia seletiva filtrada fica legível no guest sem montar registros host ou criar ferramenta de logs.
- [x] EOF/erro confirmado fecha novas chamadas e solicita abort/parada supervisionada; silêncio e comando longo não comprovam desconexão, e retorno SDK não comprova cessação.
- [x] Integração com SDK e modelo reais registra perfil, sessão, ferramenta/resultado e limites observados; falha crítica de captura impede passos dependentes em vez de inventar sucesso.

## Referências e validação

- Autoridade: [spec técnica aprovada](../../software-factory/spec.md), seções 2.3, 5.1, 5.3, 5.4, 6.1, 7.5, 12.2; [PRD](../../software-factory/prd.md) e decisões canônicas vinculadas pela spec.
- Cenários: V-02, V-03, V-11, V-15 da [matriz de aceite](../../software-factory/acceptance-and-incremental-plan.md); registrar subcasos, nível fiel, expectativa/observado, lacunas e evidências da composição efetivamente testada. Dublê não comprova fronteira substituída.
- Aplicar o gate de desenvolvimento da spec: arquitetura estática, compilação/typecheck, suíte local completa e evidências reais pertinentes à mudança, sem adiar a prova da fronteira alterada para a release.

## Autorização e limites

Publicação é planejamento aprovado, não autorização de construção, uso de host/credenciais/GitHub/modelos reais, injeção de falhas ou piloto. Obter autorização pertinente antes da execução. Não alterar decisões aprovadas silenciosamente; lacuna de desenho volta ao operador. Merge e avaliação humana não são delegados aos agentes.

## Comments

- Implementação **parcial**, não aceite: `docs/evidence/05-protected-output-and-sdk-candidate.md` descreve Records real/filesystem, filtragem incremental, paginação e o candidato SDK local. Nenhum AC integral foi marcado como comprovado.
- Gap reproduzido em Pi coding-agent 1.5.2: `createReadTool` consulta o filesystem host antes das `ReadOperations` substituídas. Candidato mínimo versionado, somente em cópia privada de fixture, preserva leitura/paginação/imagem nativas; **não adotado** como fork/dependência runtime. Requer avaliação/decisão do responsável antes de uso operacional.
- Permanecem não implementados ativação supervisionada, recibo específico de início/reserva, `executeTool`/transporte do proprietário existente, projeção por papel, cópia seletiva ao guest e parada por EOF. São trabalho local restante, não redesenho obrigatório nem provas por dublê.
- Chamadas reais continuam retidas: falta provider/modelo suportado e mecanismo verificável de credencial independente + contabilização agregada/cap autorizado. O aceite com modelo real e as provas físicas pertinentes não foram executados nem inferidos dos testes locais. Ticket não resolvido; integração de partial/stub não constitui aceite.

## Answer

Resolvido em 2026-11-14: qualificação física v4 completa (VM Gondolin real, worker Node novo, Write/Edit/Bash/Read/cópia/seleção, modelo real openai/gpt-6-luna via OAuth Factory) e gate local completo verde. Níveis e lacunas declarados em `docs/evidence/05-physical-qualification-and-acceptance.md`.
