(function () {
  'use strict';

  function handleKnowledgeLink(event) {
    const target = event.target instanceof Element ? event.target : null;
    const link = target?.closest?.('[data-team-open-link="knowledge_article"]');
    if (!link) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();

    const articleId = String(link.dataset.teamLinkKey || '').trim();
    if (!articleId) return;

    const open = () => {
      const knowledgeButton = document.querySelector('.nav-item[data-view="knowledge"]');
      if (knowledgeButton) knowledgeButton.click();
      else if (typeof window.setActiveView === 'function') window.setActiveView('knowledge');
      window.setTimeout(() => window.AtlasKnowledge?.openArticle?.(articleId), 160);
    };

    if (window.AtlasKnowledge) open();
    else window.setTimeout(open, 80);
  }

  // Team Messages delegates clicks at the document level. Capture Knowledge
  // links first so an older fallback cannot route the new link type to Inventory.
  document.addEventListener('click', handleKnowledgeLink, true);

  window.AtlasKnowledgeTeamLinkBridge = {
    openArticle: (articleId) => {
      const id = String(articleId || '').trim();
      if (!id) return;
      const knowledgeButton = document.querySelector('.nav-item[data-view="knowledge"]');
      knowledgeButton?.click();
      window.setTimeout(() => window.AtlasKnowledge?.openArticle?.(id), 160);
    }
  };

  window.addEventListener('pagehide', () => {
    document.removeEventListener('click', handleKnowledgeLink, true);
  }, { once: true });
})();
