(function () {
  'use strict';

  // S88: Knowledge links from Team Messages resolve through the shell's typed
  // link registry: knowledge-workspace.js registers 'knowledge_article' with
  // AtlasShell.registerLink and team-messages.js calls AtlasShell.openLink.
  // This file no longer intercepts document clicks; it keeps its public name
  // for callers that still use it until config.js stops loading it.
  window.AtlasKnowledgeTeamLinkBridge = {
    openArticle: (articleId) => {
      const id = String(articleId || '').trim();
      if (!id) return;
      window.AtlasShell?.openLink?.('knowledge_article', id, { source: 'bridge' });
    }
  };
})();
