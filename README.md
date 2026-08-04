# vcall

Softphone construído com **Electron** e **JsSIP**.

## Funcionalidades

- **Configuração SIP local** — domínio, WebSocket, URI SIP, ramal, nome de exibição e senha
- **Preferências** — atendimento automático, gravação automática, espera na linha, clique para ligar
- **Temas** — claro e escuro
- **Atalhos de teclado** — F1 Atender, F2 Desligar, F3 Mudo, F4 Espera, F5 Foco na discagem
- **Teste de áudio** — microfone e alto-falante nas configurações
- **Medidores em tempo real** — nível do microfone e áudio remoto durante chamadas
- **Diagnóstico** — WebRTC, permissões, registro SIP, WebSocket, ICE e faixas de mídia
- **Contatos** — adicionar, editar, excluir, pesquisar e favoritar
- **Histórico de chamadas** — com discagem rápida
- **Detecção vcall** — links `tel:` e números em páginas web com botão de chamada
- **Chamadas** — discagem, contatos, histórico e números detectados
- **Controles** — atender, rejeitar, desligar, silenciar, espera/retomar
- **DTMF** — teclado durante chamada
- **Transferência** — cega, assistida e consulta

## Requisitos

- Node.js 18+
- Servidor SIP/WebRTC compatível (Asterisk, FreeSWITCH, etc.)

## Instalação

```bash
git clone https://github.com/SEU_USUARIO/voxcall.git
cd voxcall
npm install
```

## Executar

```bash
npm start
```

Modo desenvolvimento (com DevTools):

```bash
npm run dev
```

## Configuração SIP

1. Abra **Configurações**
2. Preencha domínio, URL WebSocket (`wss://...`), URI SIP, ramal, nome e senha
3. Clique em **Salvar e Conectar**

### Exemplo Asterisk

| Campo | Valor |
|-------|-------|
| Domínio | `sip.exemplo.com.br` |
| WebSocket | `wss://sip.exemplo.com.br:8089/ws` |
| URI SIP | `sip:1001@exemplo.com.br` |
| Ramal | `1001` |

## Atalhos

| Tecla | Ação |
|-------|------|
| F1 | Atender chamada |
| F2 | Desligar |
| F3 | Silenciar/Ativar microfone |
| F4 | Espera / Retomar |
| F5 | Foco no teclado de discagem |

## Licença

MIT
