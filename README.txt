Câmeras Uai Telecom — versão final otimizada

Deploy rápido
1) Instale Node.js 20+ e FFmpeg no servidor.
2) Extraia este ZIP.
3) Rode:
   npm install
   npm start
4) Acesse:
   http://IP-DO-SERVIDOR:8085

Login padrão
- usuário: admin
- senha: admin123

Melhorias desta versão
- identidade visual Uai Telecom
- reconexão individual por câmera, com intervalo maior para não sobrecarregar o servidor
- foco fixo em 1 câmera sem trocar sozinho
- gravação contínua até cancelamento manual
- retomada automática da gravação se o FFmpeg cair inesperadamente
- mosaico mais estável para desktop e mobile
- atualização periódica do estado das câmeras e gravações
- autoexclusão de gravações antigas

Observações
- altere a senha padrão após o primeiro acesso
- para produção, configure a variável SESSION_SECRET antes de iniciar
