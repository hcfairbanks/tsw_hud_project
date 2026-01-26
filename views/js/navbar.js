/**
 * TSW HUD Project - Navbar Component
 * Include this script to automatically inject a consistent navigation bar
 *
 * Usage: Add <nav id="main-nav"></nav> where you want the navbar, then include this script
 */
(function() {
    var navLinks = [
        { href: '/countries', label: 'Countries', i18n: 'nav.countries' },
        { href: '/', label: 'Home', i18n: 'nav.home' },
        { href: '/huds', label: 'HUD', i18n: 'nav.hud' },
        { href: '/record', label: 'Record Map', i18n: 'nav.record' },
        { href: '/routes', label: 'Routes', i18n: 'nav.routes' },
        { href: '/settings', label: 'Settings', i18n: 'nav.settings' },
        { href: '/timetables', label: 'Timetables', i18n: 'nav.timetables' },
        { href: '/map', label: 'Tracking Map', i18n: 'nav.map' },
        { href: '/train-classes', label: 'Train Classes', i18n: 'nav.trainClasses' },
        { href: '/trains', label: 'Trains', i18n: 'nav.trains' },
        { href: '/weather', label: 'Weather', i18n: 'nav.weather' }
    ];

    function createNavbar() {
        var navContainer = document.getElementById('main-nav');
        if (!navContainer) return;

        // Add the nav class for styling
        navContainer.className = 'nav';

        // Create links
        navLinks.forEach(function(link) {
            var a = document.createElement('a');
            a.href = link.href;
            a.textContent = link.label;
            if (link.i18n) {
                a.setAttribute('data-i18n', link.i18n);
            }

            // Highlight current page
            if (window.location.pathname === link.href ||
                (link.href !== '/' && window.location.pathname.startsWith(link.href))) {
                a.style.background = 'var(--accent-color)';
                a.style.color = 'var(--bg-primary)';
            }

            navContainer.appendChild(a);
        });

        // Add language selector placeholder (populated by i18n.js)
        var langContainer = document.createElement('div');
        langContainer.className = 'language-selector-nav';
        navContainer.appendChild(langContainer);
    }

    // Create navbar when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createNavbar);
    } else {
        createNavbar();
    }
})();
