/**
 * Professional Enhancement Script for WhatsApp Agent
 * Adds smooth interactions, animations, and enterprise-grade UX improvements
 */

(function() {
  'use strict';

  // Professional Loading States
  class LoadingManager {
    constructor() {
      this.loadingElements = new Set();
      this.init();
    }

    init() {
      this.setupPageTransition();
      this.setupLoadingStates();
    }

    setupPageTransition() {
      // Add page transition effect
      document.addEventListener('DOMContentLoaded', () => {
        document.body.style.opacity = '0';
        document.body.style.transition = 'opacity 0.3s ease-in-out';
        
        setTimeout(() => {
          document.body.style.opacity = '1';
        }, 100);
      });
    }

    setupLoadingStates() {
      // Add loading states to buttons and forms
      const buttons = document.querySelectorAll('button');
      buttons.forEach(button => {
        if (!button.hasAttribute('data-loading')) {
          button.addEventListener('click', (e) => {
            // Only show loading state when explicitly opted-in
            if (button.hasAttribute('data-loading') || button.classList.contains('submit-btn')) {
              this.showLoading(button);
            }
          });
        }
      });
    }

    showLoading(element) {
      const originalText = element.textContent;
      element.setAttribute('data-loading', 'true');
      element.textContent = 'Loading...';
      element.disabled = true;
      
      // Add loading spinner
      const spinner = document.createElement('span');
      spinner.className = 'loading-spinner';
      spinner.innerHTML = '⟳';
      spinner.style.cssText = `
        display: inline-block;
        margin-right: 8px;
        animation: spin 1s linear infinite;
        font-size: 14px;
      `;
      
      element.insertBefore(spinner, element.firstChild);
      
      // Store original content for restoration
      element.dataset.originalText = originalText;
    }

    hideLoading(element) {
      if (element.hasAttribute('data-loading')) {
        element.removeAttribute('data-loading');
        element.disabled = false;
        element.textContent = element.dataset.originalText || 'Submit';
        
        const spinner = element.querySelector('.loading-spinner');
        if (spinner) {
          spinner.remove();
        }
      }
    }
  }

  // Enhanced Scroll Manager
  class ScrollManager {
    constructor() {
      this.init();
    }

    init() {
      this.setupSmoothScroll();
      this.setupScrollToTop();
      this.setupInfiniteScroll();
    }

    setupSmoothScroll() {
      // Enhanced smooth scrolling for all links
      document.addEventListener('click', (e) => {
        const link = e.target.closest('a[href^="#"]');
        if (link) {
          e.preventDefault();
          const target = document.querySelector(link.getAttribute('href'));
          if (target) {
            target.scrollIntoView({
              behavior: 'smooth',
              block: 'start'
            });
          }
        }
      });
    }

    setupScrollToTop() {
      // Add scroll to top button
      const scrollToTopBtn = document.createElement('button');
      scrollToTopBtn.className = 'scroll-to-top';
      scrollToTopBtn.innerHTML = '↑';
      scrollToTopBtn.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        width: 50px;
        height: 50px;
        border-radius: 50%;
        background: var(--primary-600);
        color: white;
        border: none;
        cursor: pointer;
        font-size: 20px;
        font-weight: bold;
        box-shadow: var(--shadow-lg);
        transition: all 0.3s ease;
        opacity: 0;
        visibility: hidden;
        z-index: 1000;
      `;

      document.body.appendChild(scrollToTopBtn);

      // Show/hide scroll to top button
      window.addEventListener('scroll', () => {
        if (window.pageYOffset > 300) {
          scrollToTopBtn.style.opacity = '1';
          scrollToTopBtn.style.visibility = 'visible';
        } else {
          scrollToTopBtn.style.opacity = '0';
          scrollToTopBtn.style.visibility = 'hidden';
        }
      });

      // Scroll to top functionality
      scrollToTopBtn.addEventListener('click', () => {
        window.scrollTo({
          top: 0,
          behavior: 'smooth'
        });
      });
    }

    setupInfiniteScroll() {
      // Auto-scroll to bottom for chat threads
      const chatThreads = document.querySelectorAll('.chat-thread');
      chatThreads.forEach(thread => {
        this.scrollToBottom(thread);
        
        // Watch for new messages
        const observer = new MutationObserver(() => {
          this.scrollToBottom(thread);
        });
        
        observer.observe(thread, {
          childList: true,
          subtree: true
        });
      });
    }

    scrollToBottom(element) {
      if (element) {
        element.scrollTop = element.scrollHeight;
      }
    }
  }

  // Professional Interaction Manager
  class InteractionManager {
    constructor() {
      this.init();
    }

    init() {
      this.setupHoverEffects();
      this.setupClickEffects();
      this.setupKeyboardNavigation();
      this.setupFormValidation();
    }

    setupHoverEffects() {
      // Enhanced hover effects for cards
      const cards = document.querySelectorAll('.card');
      cards.forEach(card => {
        card.addEventListener('mouseenter', () => {
          card.style.transform = 'translateY(-4px)';
        });
        
        card.addEventListener('mouseleave', () => {
          card.style.transform = 'translateY(0)';
        });
      });

      // Enhanced hover effects for navigation items
      const navItems = document.querySelectorAll('.sidebar .nav a');
      navItems.forEach(item => {
        item.addEventListener('mouseenter', () => {
          item.style.transform = 'translateX(6px)';
        });
        
        item.addEventListener('mouseleave', () => {
          item.style.transform = 'translateX(0)';
        });
      });
    }

    setupClickEffects() {
      // Add click ripple effect to buttons
      const buttons = document.querySelectorAll('button');
      buttons.forEach(button => {
        button.addEventListener('click', (e) => {
          this.createRipple(e, button);
        });
      });
    }

    createRipple(event, element) {
      const ripple = document.createElement('span');
      const rect = element.getBoundingClientRect();
      const size = Math.max(rect.width, rect.height);
      const x = event.clientX - rect.left - size / 2;
      const y = event.clientY - rect.top - size / 2;

      ripple.style.cssText = `
        position: absolute;
        width: ${size}px;
        height: ${size}px;
        left: ${x}px;
        top: ${y}px;
        background: rgba(255, 255, 255, 0.3);
        border-radius: 50%;
        transform: scale(0);
        animation: ripple 0.6s linear;
        pointer-events: none;
      `;

      element.style.position = 'relative';
      element.style.overflow = 'hidden';
      element.appendChild(ripple);

      setTimeout(() => {
        ripple.remove();
      }, 600);
    }

    setupKeyboardNavigation() {
      // Enhanced keyboard navigation
      document.addEventListener('keydown', (e) => {
        // Escape key to close modals
        if (e.key === 'Escape') {
          const modals = document.querySelectorAll('.modal, .day-modal');
          modals.forEach(modal => {
            if (modal.style.display !== 'none') {
              modal.style.display = 'none';
            }
          });
        }

        // Enter key to submit forms
        if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
          const form = e.target.closest('form');
          if (form) {
            const submitBtn = form.querySelector('button[type="submit"]');
            if (submitBtn) {
              submitBtn.click();
            }
          }
        }
      });
    }

    setupFormValidation() {
      // Enhanced form validation with real-time feedback
      const forms = document.querySelectorAll('form');
      forms.forEach(form => {
        const inputs = form.querySelectorAll('input, textarea, select');
        
        inputs.forEach(input => {
          input.addEventListener('blur', () => {
            this.validateField(input);
          });
          
          input.addEventListener('input', () => {
            if (input.classList.contains('error')) {
              this.validateField(input);
            }
          });
        });
      });
    }

    validateField(field) {
      const value = field.value.trim();
      const type = field.type;
      let isValid = true;
      let errorMessage = '';

      // Required field validation
      if (field.required && !value) {
        isValid = false;
        errorMessage = 'This field is required';
      }

      // Email validation
      if (type === 'email' && value) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(value)) {
          isValid = false;
          errorMessage = 'Please enter a valid email address';
        }
      }

      // URL validation
      if (type === 'url' && value) {
        try {
          new URL(value);
        } catch {
          isValid = false;
          errorMessage = 'Please enter a valid URL';
        }
      }

      // Update field appearance
      if (isValid) {
        field.classList.remove('error');
        field.classList.add('valid');
        this.removeErrorMessage(field);
      } else {
        field.classList.remove('valid');
        field.classList.add('error');
        this.showErrorMessage(field, errorMessage);
      }

      return isValid;
    }

    showErrorMessage(field, message) {
      this.removeErrorMessage(field);
      
      const errorDiv = document.createElement('div');
      errorDiv.className = 'field-error';
      errorDiv.textContent = message;
      errorDiv.style.cssText = `
        color: var(--error-500);
        font-size: 12px;
        margin-top: 4px;
        animation: fadeIn 0.3s ease;
      `;
      
      field.parentNode.appendChild(errorDiv);
    }

    removeErrorMessage(field) {
      const existingError = field.parentNode.querySelector('.field-error');
      if (existingError) {
        existingError.remove();
      }
    }
  }

  // Professional Animation Manager
  class AnimationManager {
    constructor() {
      this.init();
    }

    init() {
      this.setupIntersectionObserver();
      this.addCSSAnimations();
    }

    setupIntersectionObserver() {
      // Animate elements when they come into view
      const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            entry.target.classList.add('animate-in');
          }
        });
      }, {
        threshold: 0.1,
        rootMargin: '0px 0px -50px 0px'
      });

      const animateElements = document.querySelectorAll('.card, .list li, .guide-card');
      animateElements.forEach(el => {
        observer.observe(el);
      });
    }

    addCSSAnimations() {
      // Add CSS animations if not already present
      if (!document.getElementById('enhancement-styles')) {
        const style = document.createElement('style');
        style.id = 'enhancement-styles';
        style.textContent = `
          @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
          }
          
          @keyframes ripple {
            to {
              transform: scale(4);
              opacity: 0;
            }
          }
          
          @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
          }
          
          @keyframes slideInUp {
            from {
              opacity: 0;
              transform: translateY(30px);
            }
            to {
              opacity: 1;
              transform: translateY(0);
            }
          }
          
          .animate-in {
            animation: slideInUp 0.6s ease-out;
          }
          
          .error {
            border-color: var(--error-500) !important;
            box-shadow: 0 0 0 4px var(--error-100) !important;
          }
          
          .valid {
            border-color: var(--success-500) !important;
            box-shadow: 0 0 0 4px var(--success-100) !important;
          }
        `;
        document.head.appendChild(style);
      }
    }
  }

  // Lightweight Parallax Manager for landing sections
  class ParallaxManager {
    constructor() {
      this.items = [];
      this.ticking = false;
      this.scroller = null;
      this.bind();
    }
    bind() {
      document.addEventListener('DOMContentLoaded', () => {
        this.items = Array.from(document.querySelectorAll('[data-parallax-speed]'));
        if (!this.items.length) return;
        // Determine the active scroll container (window/document/body fallback)
        this.scroller = document.scrollingElement || document.documentElement || document.body;
        this.onScroll(); // initial paint
        // Listen to both window and the scroller element to be safe across browsers/CSS
        window.addEventListener('scroll', () => this.requestTick(), { passive: true });
        this.scroller.addEventListener && this.scroller.addEventListener('scroll', () => this.requestTick(), { passive: true });
        window.addEventListener('resize', () => this.onScroll(), { passive: true });
      });
    }
    requestTick() {
      if (!this.ticking) {
        this.ticking = true;
        requestAnimationFrame(() => {
          this.onScroll();
          this.ticking = false;
        });
      }
    }
    onScroll() {
      const viewportH = window.innerHeight || (this.scroller && this.scroller.clientHeight) || 0;
      const scrollTop = window.pageYOffset != null ? window.pageYOffset : (this.scroller ? this.scroller.scrollTop : 0);
      this.items.forEach(el => {
        const speed = parseFloat(el.getAttribute('data-parallax-speed')) || 0.3;
        const rect = el.getBoundingClientRect();
        // Convert rect.top (relative to viewport) to a stable offset using current scroll
        const elementCenterY = scrollTop + rect.top + rect.height / 2;
        const viewportCenterY = scrollTop + (viewportH / 2);
        const centerOffset = viewportCenterY - elementCenterY;
        const translate = centerOffset * speed;
        el.style.transform = `translateY(${translate.toFixed(2)}px)`;
      });
    }
  }

  // Initialize all managers when DOM is ready
  document.addEventListener('DOMContentLoaded', () => {
    new LoadingManager();
    new ScrollManager();
    new InteractionManager();
    new AnimationManager();
    new ParallaxManager();
  });

  // Export for potential external use
  window.WhatsAppAgentEnhancements = {
    LoadingManager,
    ScrollManager,
    InteractionManager,
    AnimationManager,
    ParallaxManager
  };

})();
