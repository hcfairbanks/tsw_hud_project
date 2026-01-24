/**
 * TSW HUD Project - Navbar Component
 * Include this script to automatically inject a consistent navigation bar
 *
 * Usage: Add <nav id="main-nav"></nav> where you want the navbar, then include this script
 */
(function() {
    var navLinks = [
        { href: '/', label: 'Home' },
        { href: '/huds', label: 'HUD' },
        { href: '/map', label: 'Tracking Map' },
        { href: '/record', label: 'Record Map' },
        { href: '/routes', label: 'Routes' },
        { href: '/trains', label: 'Trains' },
        { href: '/timetables', label: 'Timetables' },
        { href: '/extract', label: 'Extract' },
        { href: '/weather', label: 'Weather' },
        { href: '/settings', label: 'Settings' }
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

            // Highlight current page
            if (window.location.pathname === link.href ||
                (link.href !== '/' && window.location.pathname.startsWith(link.href))) {
                a.style.background = 'var(--accent-color)';
                a.style.color = 'var(--bg-primary)';
            }

            navContainer.appendChild(a);
        });
    }

    // Create navbar when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createNavbar);
    } else {
        createNavbar();
    }
})();
