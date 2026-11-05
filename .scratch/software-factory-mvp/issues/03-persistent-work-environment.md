# 03: Preparar, iniciar e parar um ambiente persistente por Trabalho

**What to build:** Uma integração autorizada prepara um ambiente próprio, inicia o guest, modifica dados e o desliga/reinicia sem perder disco ou workspace. O controlador consegue conhecer a condição e confirmar cessação mesmo se o proprietário anterior morrer.

**Blocked by:** [01: Preparar a instalação local e o gate de desenvolvimento](01-local-setup-and-development-gate.md)

**Status:** ready-for-agent

## Acceptance criteria

- [ ] Interface pública de Sandbox permite validar sem boot, preparar idempotentemente, iniciar com boot novo, observar, parar e remover recursos próprios; refs são opacas para Controle e resultados distinguem sucesso, falha e indeterminação.
- [ ] Perfil fixado usa Arch x86_64, QEMU/KVM e Alpine com assets íntegros; configuração aprovada é validada sem coerção e sem flags livres, scripts/mounts arbitrários ou fallback de aceleração.
- [ ] Disco próprio persistente, rootDiskDeleteOnClose desabilitado e configuração de tmpfs aprovada preservam arquivos/pacotes/caches esperados entre boots, sem prometer preservar processos/RAM.
- [ ] RealFSProvider expõe apenas workspace/artefatos próprios; testes de paths, symlinks e aliases negam escape para home, controlador, registros, cache Git ou outro Trabalho.
- [ ] Systemd supervisiona adapter/workers/VMM/subprocessos por identidade; observação e parada host funcionam sem adapter anterior e não afetam outro ambiente.
- [ ] Parada tenta cessação graciosa e depois término forçado próprio; pedido/exit code isolado não comprova cessação, e disco forçadamente parado é verificado antes de reuso.
- [ ] Piso livre, espaço físico/virtual e configuração efetiva são observáveis; falta de espaço impede operações afetadas sem apagar recursos para abrir espaço nem matar ativo automaticamente.
- [ ] Provas reais incluem ciclo persistente, falha do proprietário e isolamento entre ambientes; não usam dublê como prova de KVM, filesystem ou cessação.

## Referências e validação

- Autoridade: [spec técnica aprovada](../../software-factory/spec.md), seções 5.4, 7.1, 7.2, 7.3, 7.4; [PRD](../../software-factory/prd.md) e decisões canônicas vinculadas pela spec.
- Cenários: V-02, V-12, V-14 da [matriz de aceite](../../software-factory/acceptance-and-incremental-plan.md); registrar subcasos, nível fiel, expectativa/observado, lacunas e evidências da composição efetivamente testada. Dublê não comprova fronteira substituída.
- Aplicar o gate de desenvolvimento da spec: arquitetura estática, compilação/typecheck, suíte local completa e evidências reais pertinentes à mudança, sem adiar a prova da fronteira alterada para a release.

## Autorização e limites

Publicação é planejamento aprovado, não autorização de construção, uso de host/credenciais/GitHub/modelos reais, injeção de falhas ou piloto. Obter autorização pertinente antes da execução. Não alterar decisões aprovadas silenciosamente; lacuna de desenho volta ao operador. Merge e avaliação humana não são delegados aos agentes.
