/* =========================================================
   BANCO DE PREGUNTAS — LAN ACADEMY
   Compartido por el formulario y el panel de staff
   ========================================================= */
window.LAN_ACADEMY_MODULOS = [
  {
    titulo: 'Interpretación de instrucciones ATC',
    preguntas: [
      { n: 1, tipo: 'mc', texto: 'Te encuentras en viento en cola dentro del circuito. El controlador te indica: “LAN123, mantenga posición y realice circuito cerrado para aproximación”. ¿Qué deberías hacer?', opciones: [
        'Continuar directamente hacia la pista y aterrizar.',
        'Interpretar la instrucción según los procedimientos de LAN y solicitar aclaración si resulta ambigua.',
        'Abandonar el circuito inmediatamente.',
        'Despegar nuevamente sin autorización.'
      ]},
      { n: 2, tipo: 'mc', texto: 'Estás en aproximación final, pero no has recibido autorización de aterrizaje. Además, observas que otra aeronave ocupa la pista. ¿Qué debes hacer?', opciones: [
        'Aterrizar rápidamente antes de que la otra aeronave se mueva.',
        'Ignorar al controlador.',
        'Mantener una operación segura, comunicar la situación y ejecutar las instrucciones correspondientes.',
        'Apagar el motor en aproximación.'
      ]},
      { n: 3, tipo: 'tf', texto: 'Si estás alineado en la pista y el controlador te dice “mantenga posición, tráfico en aproximación”, puedes despegar si consideras que tienes suficiente espacio.' },
      { n: 4, tipo: 'mc', texto: 'El controlador cambia tu pista asignada de la 09 a la 27. ¿Qué deberías hacer?', opciones: [
        'Continuar hacia la pista anterior.',
        'Confirmar la nueva asignación y revisar los aspectos de la operación que puedan verse afectados.',
        'Despegar desde cualquier pista disponible.',
        'Ignorar el cambio si ya estás en rodaje.'
      ]},
      { n: 5, tipo: 'open', texto: 'Recibes una instrucción ATC, pero debido a interferencia no logras entenderla completamente. Explica cómo actuarías y qué comunicarías al controlador.' }
    ]
  },
  {
    titulo: 'Procedimientos de vuelo',
    preguntas: [
      { n: 6, tipo: 'mc', texto: '¿Cuál es la secuencia general de un circuito de tránsito?', opciones: [
        'Despegue, base, viento en cola, final.',
        'Despegue, viento en cola, base, final.',
        'Final, base, despegue, viento en cola.',
        'Despegue, final, base, viento en cola.'
      ]},
      { n: 7, tipo: 'mc', texto: 'Durante la aproximación final notas que la aeronave está desviada del eje de pista y la aproximación no es estable. ¿Qué decisión es la más segura?', opciones: [
        'Continuar obligatoriamente hasta aterrizar.',
        'Realizar correcciones bruscas para aterrizar rápidamente.',
        'Evaluar la estabilidad y ejecutar una aproximación frustrada si no se cumplen las condiciones seguras.',
        'Desconectar la comunicación con ATC.'
      ]},
      { n: 8, tipo: 'tf', texto: 'Una aproximación frustrada significa que debes abandonar el aterrizaje y ejecutar el procedimiento correspondiente, coordinando con ATC.' },
      { n: 9, tipo: 'mc', texto: 'Después de aterrizar, el controlador te indica que continúes por una calle de rodaje específica. ¿Qué debes hacer?', opciones: [
        'Cruzar cualquier pista que encuentres.',
        'Seguir la instrucción y no ingresar o cruzar otra pista sin la autorización correspondiente.',
        'Detenerte en medio de la pista sin comunicarlo.',
        'Apagar inmediatamente la aeronave.'
      ]},
      { n: 10, tipo: 'open', texto: 'Antes de solicitar autorización de rodaje, ¿qué verificaciones realizarías en la aeronave y qué información deberías tener clara sobre el aeropuerto y el vuelo?' }
    ]
  },
  {
    titulo: 'Toma de decisiones y seguridad operacional',
    preguntas: [
      { n: 11, tipo: 'mc', texto: 'Durante el vuelo pierdes comunicación con el controlador. ¿Cuál debería ser tu primera acción?', opciones: [
        'Continuar como si nada hubiera ocurrido.',
        'Intentar recuperar la comunicación y mantener una trayectoria segura.',
        'Realizar maniobras bruscas para llamar la atención.',
        'Desconectar todos los sistemas.'
      ]},
      { n: 12, tipo: 'tf', texto: 'Si observas una aeronave cerca de tu trayectoria y no tienes información suficiente sobre ella, debes mantener conciencia de la situación y comunicarlo a ATC cuando sea posible.' },
      { n: 13, tipo: 'mc', texto: 'Durante el vuelo las condiciones meteorológicas empeoran y la visibilidad disminuye. ¿Qué deberías hacer?', opciones: [
        'Continuar sin evaluar las condiciones.',
        'Evaluar la situación, informar a ATC y considerar alternativas seguras.',
        'Aumentar la velocidad sin considerar las condiciones.',
        'Ignorar las condiciones meteorológicas.'
      ]},
      { n: 14, tipo: 'open', texto: 'Durante el rodaje te das cuenta de que has tomado una calle equivocada y te estás acercando a una pista. Explica qué harías inmediatamente y cómo informarías el error al controlador.' },
      { n: 15, tipo: 'mc', texto: 'Mientras ATC te ordena realizar un viraje, notas que la aeronave presenta un comportamiento inesperado. ¿Qué debe tener prioridad?', opciones: [
        'Cumplir la instrucción ATC sin importar la situación.',
        'Mantener el control de la aeronave, evaluar la situación y comunicar cualquier limitación a ATC.',
        'Ignorar completamente la aeronave.',
        'Realizar un viraje brusco inmediatamente.'
      ]}
    ]
  },
  {
    titulo: 'Comunicaciones aeronáuticas',
    preguntas: [
      { n: 16, tipo: 'mc', texto: 'El controlador te dice: “LAN123, autorizado a despegar pista 09, viento 080 grados, 5 nudos”. ¿Cuál respuesta es la más apropiada?', opciones: [
        '“LAN123, entendido”.',
        '“LAN123, autorizado a despegar pista 09”.',
        '“Despegando, gracias”.',
        '“LAN123, voy a aterrizar”.'
      ]},
      { n: 17, tipo: 'open', texto: 'Te encuentras en plataforma y deseas iniciar el rodaje hacia la pista asignada. Escribe una transmisión que incluya tu identificación, posición, intención y pista solicitada.' },
      { n: 18, tipo: 'mc', texto: 'El controlador te indica: “LAN123, continúe por calle Alfa, mantenga antes de pista 09”. ¿Qué debes hacer?', opciones: [
        'Cruzar la pista 09 inmediatamente.',
        'Continuar por Alfa y detenerte antes de la pista, sin cruzarla hasta recibir autorización explícita.',
        'Ingresar a la pista para esperar.',
        'Ignorar la instrucción.'
      ]},
      { n: 19, tipo: 'tf', texto: 'Una transmisión de radio debe ser clara, breve y contener la información necesaria para que ATC comprenda tu situación.' },
      { n: 20, tipo: 'open', texto: 'Durante el vuelo se presenta una situación crítica que requiere asistencia inmediata. Escribe un mensaje breve que transmitirías a ATC. Incluye tu identificación, posición o fase de vuelo, naturaleza de la situación e intención.' }
    ]
  }
];

// Respuestas correctas (preguntas cerradas)
window.LAN_ACADEMY_KEY = {
  1: 'B', 2: 'C', 3: 'Falso', 4: 'B',
  6: 'B', 7: 'C', 8: 'Verdadero', 9: 'B',
  11: 'B', 12: 'Verdadero', 13: 'B', 15: 'B',
  16: 'B', 18: 'B', 19: 'Verdadero'
};

// Preguntas abiertas (las califica el staff)
window.LAN_ACADEMY_ABIERTAS = [5, 10, 14, 17, 20];
