(() => {
  'use strict';

  // S38 owner remediation. Until S88 this file re-applied its fixes after every
  // DOM mutation (a body-wide MutationObserver) and intercepted scanner taps in
  // the capture phase. Each fix now lives in the module that renders the markup:
  //
  //   scanner close/stepper, quantity input mode   atlas-capture.js, stock-count-workspace.js (S88)
  //   purchasing tabs and sections                 atlas-purchasing.js (S88 routes)
  //   message list role=log, notification copy     team-messages.js
  //   body.s38-team-active                          retired (Messages is an AtlasShell view)
  //   body.s38-month-active                         retired (Month is part of shifts-workspace.js)
  //   close controls type/touch-action             their owners' markup
  //   Home timeline display/aria-hidden            index.html layoutAtlasView
  //   "Scheduled today" attention pulse            operations-checkpoint-a-layout.js
  //   topbar bell routing                          index.html
  //
  // The styles stay in assets/css/s38-app-remediation.css. This script keeps its
  // public marker for callers until config/index stop loading it.
  window.AtlasS38Remediation = {
    apply() {},
    version: 's38-owner-remediation-v9'
  };
})();
