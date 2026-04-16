/* ═══════════════════════════════════════════
   MOBILE SUPPORT
   ═══════════════════════════════════════════ */

(() => {
  const panel = document.getElementById('sidePanel');
  const backdrop = document.getElementById('mobileBackdrop');
  const menuBtn = document.getElementById('mobileMenuBtn');
  const mobileNewChat = document.getElementById('mobileNewChatBtn');
  const mobileTitle = document.getElementById('mobileHeaderTitle');

  function isMobile() {
    return window.matchMedia('(max-width: 768px)').matches;
  }

  function openSidebar() {
    panel.classList.add('mobile-open');
    backdrop.classList.add('visible');
    document.body.style.overflow = 'hidden';
  }

  function closeSidebar() {
    panel.classList.remove('mobile-open');
    backdrop.classList.remove('visible');
    document.body.style.overflow = '';
  }

  // Hamburger menu
  if (menuBtn) {
    menuBtn.addEventListener('click', () => {
      if (panel.classList.contains('mobile-open')) {
        closeSidebar();
      } else {
        openSidebar();
      }
    });
  }

  // Backdrop tap closes sidebar
  if (backdrop) {
    backdrop.addEventListener('click', closeSidebar);
  }

  // Mobile new-chat button triggers the sidebar's new chat btn
  if (mobileNewChat) {
    mobileNewChat.addEventListener('click', () => {
      const btn = document.getElementById('newChatBtn');
      if (btn) btn.click();
    });
  }

  // Close sidebar when a chat item is clicked on mobile
  const sidebarChats = document.getElementById('sidebarChats');
  if (sidebarChats) {
    sidebarChats.addEventListener('click', (e) => {
      if (isMobile() && e.target.closest('.sidebar-chat-item')) {
        closeSidebar();
      }
    });
  }

  // Close sidebar when graph toggle is clicked on mobile
  const graphBtn = document.getElementById('graphToggleBtn');
  if (graphBtn) {
    graphBtn.addEventListener('click', () => {
      if (isMobile()) closeSidebar();
    });
  }

  // Sync mobile header title with breadcrumb
  const breadcrumbTitle = document.getElementById('chatBreadcrumbTitle');
  if (breadcrumbTitle && mobileTitle) {
    const observer = new MutationObserver(() => {
      mobileTitle.textContent = breadcrumbTitle.textContent || 'Network Map';
    });
    observer.observe(breadcrumbTitle, { childList: true, characterData: true, subtree: true });
  }

  // On resize, clean up mobile state if switching to desktop
  window.addEventListener('resize', () => {
    if (!isMobile()) {
      closeSidebar();
    }
  });

  // Prevent iOS bounce/zoom on input focus
  document.addEventListener('touchmove', (e) => {
    if (document.body.style.overflow === 'hidden' && !panel.contains(e.target)) {
      e.preventDefault();
    }
  }, { passive: false });

})();
