/**
 * TSW HUD Project - Theme Loader
 * Include this script to automatically apply the user's theme preference
 */
(function() {
    // Apply theme from localStorage immediately (before DOM loads)
    function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        document.body && document.body.setAttribute('data-theme', theme);
    }

    // Try localStorage first for instant apply
    var savedTheme = localStorage.getItem('theme');
    if (savedTheme) {
        applyTheme(savedTheme);
    }

    // Fetch from server to ensure sync
    fetch('/api/config')
        .then(function(res) { return res.json(); })
        .then(function(config) {
            var theme = config.theme || 'dark';
            applyTheme(theme);
            localStorage.setItem('theme', theme);
        })
        .catch(function(err) {
            console.error('Failed to load config:', err);
        });

    // Re-apply when DOM is ready (in case body wasn't available initially)
    document.addEventListener('DOMContentLoaded', function() {
        var theme = localStorage.getItem('theme') || 'dark';
        applyTheme(theme);
    });
})();
