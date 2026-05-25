/**
 * Syn Player - Main JavaScript
 * Handles: carousel, navigation, thumbnails, video player
 */

document.addEventListener('DOMContentLoaded', function() {

    // ============ Inject Search Overlay ============
    var searchOverlayHTML = '' +
    '<div class="search-overlay" id="searchOverlay">' +
    '  <div class="search-overlay-backdrop"></div>' +
    '  <div class="search-overlay-panel">' +
    '    <button class="search-overlay-close" id="searchOverlayClose"><i class="fas fa-times"></i></button>' +
    '    <div class="search-overlay-content" id="searchOverlayContent">' +
    '      <div class="search-overlay-icon"><i class="fas fa-search"></i></div>' +
    '      <h2 class="search-overlay-query" id="searchOverlayQuery"></h2>' +
    '      <div class="search-overlay-results" id="searchOverlayResults">' +
    '        <div class="search-no-results">' +
    '          <i class="fas fa-film"></i>' +
    '          <p>抱歉，未找到相关内容</p>' +
    '          <p class="search-no-hint">请尝试其他关键词，或浏览下方推荐内容</p>' +
    '        </div>' +
    '      </div>' +
    '    </div>' +
    '  </div>' +
    '</div>';
    document.body.insertAdjacentHTML('beforeend', searchOverlayHTML);

    // ============ User Auth ============
    var userToken = localStorage.getItem('syn_user_token');
    var userData = null;
    try { userData = JSON.parse(localStorage.getItem('syn_user')); } catch(e) {}

    // Redirect if no token
    if (!userToken && !window.location.pathname.includes('/admin')) {
        if (window.location.pathname !== '/' && !window.location.pathname.endsWith('login.html')) {
            window.location.href = '/';
            return;
        }
    }

    // Update navbar: show username + logout
    var userCircleLink = document.querySelector('.nav-right a[title="登录"]');
    if (userCircleLink && userData) {
        userCircleLink.href = 'javascript:;';
        userCircleLink.title = userData.username;
        var span = document.createElement('span');
        span.className = 'nav-user-name';
        span.style.cssText = 'font-size:13px;margin-left:4px;';
        span.textContent = userData.username;
        userCircleLink.innerHTML = '<i class="fas fa-user-check"></i> ';
        userCircleLink.appendChild(span);
    }

    // Logout functionality
    var logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', function() {
            localStorage.removeItem('syn_user_token');
            localStorage.removeItem('syn_user');
            document.cookie = 'syn_user_token=; path=/; max-age=0';
            window.location.href = '/';
        });
    }

    // Inject password change modal & button (shared across all pages)
    (function initPasswordChange() {
        if (!userToken) return;
        // Inject button into nav
        var navRight = document.querySelector('.nav-right');
        if (navRight && !document.getElementById('passwordBtn')) {
            var pwBtn = document.createElement('button');
            pwBtn.id = 'passwordBtn';
            pwBtn.className = 'nav-icon';
            pwBtn.title = '修改密码';
            pwBtn.style.cssText = 'background:none;border:none;cursor:pointer;';
            pwBtn.innerHTML = '<i class="fas fa-key" style="color:#ffa500;"></i>';
            navRight.appendChild(pwBtn);
        }
        // Inject modal if not present
        if (!document.getElementById('passwordModal')) {
            var modalHTML = '' +
            '<div class="password-modal-overlay" id="passwordModal" style="display:none;">' +
            '  <div class="password-modal">' +
            '    <div class="password-modal-header">' +
            '      <h3>修改密码</h3>' +
            '      <button class="password-modal-close" id="passwordModalClose">&times;</button>' +
            '    </div>' +
            '    <div class="password-modal-body">' +
            '      <p class="password-msg" id="passwordMsg"></p>' +
            '      <div class="field"><input type="password" id="currentPassword" placeholder="当前密码" autocomplete="current-password"></div>' +
            '      <div class="field"><input type="password" id="newPassword" placeholder="新密码（至少6位）" autocomplete="new-password"></div>' +
            '      <div class="field"><input type="password" id="confirmPassword" placeholder="确认新密码"></div>' +
            '      <button class="btn-submit" id="passwordSubmit">确认修改</button>' +
            '    </div>' +
            '  </div>' +
            '</div>';
            document.body.insertAdjacentHTML('beforeend', modalHTML);
        }
        // Wire up events
        setTimeout(function() {
            var btn = document.getElementById('passwordBtn');
            var modal = document.getElementById('passwordModal');
            if (!btn || !modal) return;
            if (btn._wired) return;
            btn._wired = true;
            btn.addEventListener('click', function() {
                modal.style.display = 'flex';
                var msg = document.getElementById('passwordMsg');
                msg.className = 'password-msg'; msg.textContent = '';
                document.getElementById('currentPassword').value = '';
                document.getElementById('newPassword').value = '';
                document.getElementById('confirmPassword').value = '';
            });
            document.getElementById('passwordModalClose').addEventListener('click', function() {
                modal.style.display = 'none';
            });
            modal.addEventListener('click', function(e) {
                if (e.target === modal) modal.style.display = 'none';
            });
            document.getElementById('passwordSubmit').addEventListener('click', async function() {
                var msg = document.getElementById('passwordMsg');
                var cur = document.getElementById('currentPassword').value;
                var newPw = document.getElementById('newPassword').value;
                var confirm = document.getElementById('confirmPassword').value;
                if (!cur || !newPw) {
                    msg.className = 'password-msg error';
                    msg.textContent = '请填写当前密码和新密码';
                    return;
                }
                if (newPw.length < 6) {
                    msg.className = 'password-msg error';
                    msg.textContent = '新密码至少需要6个字符';
                    return;
                }
                if (newPw !== confirm) {
                    msg.className = 'password-msg error';
                    msg.textContent = '两次输入的新密码不一致';
                    return;
                }
                try {
                    var resp = await fetch('/api/auth/password', {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + userToken },
                        body: JSON.stringify({ currentPassword: cur, newPassword: newPw })
                    });
                    var data = await resp.json();
                    if (resp.ok && data.success) {
                        msg.className = 'password-msg success';
                        msg.textContent = '密码修改成功';
                        setTimeout(function() { modal.style.display = 'none'; }, 1500);
                    } else {
                        msg.className = 'password-msg error';
                        msg.textContent = data.error || '修改失败';
                    }
                } catch (e) {
                    msg.className = 'password-msg error';
                    msg.textContent = '网络错误，请重试';
                }
            });
        }, 500);
    })();

    // ============ Theme Toggle (Manual override) ============
    var themeToggle = document.getElementById('themeToggle');
    var htmlEl = document.documentElement;

    // Load saved theme preference
    var savedTheme = localStorage.getItem('syn-player-theme');
    if (savedTheme === 'light') {
        htmlEl.classList.add('light-theme');
        htmlEl.classList.remove('dark-theme');
    } else if (savedTheme === 'dark') {
        htmlEl.classList.add('dark-theme');
        htmlEl.classList.remove('light-theme');
    }

    // Update toggle icon based on current effective theme
    function updateThemeIcon() {
        if (!themeToggle) return;
        var icon = themeToggle.querySelector('i');
        var isLight = htmlEl.classList.contains('light-theme');
        // If neither class is set, detect from system
        if (!htmlEl.classList.contains('light-theme') && !htmlEl.classList.contains('dark-theme')) {
            isLight = window.matchMedia('(prefers-color-scheme: light)').matches;
        }
        if (isLight) {
            icon.className = 'fas fa-sun';
        } else {
            icon.className = 'fas fa-moon';
        }
    }

    updateThemeIcon();

    if (themeToggle) {
        themeToggle.addEventListener('click', function() {
            var isLight = htmlEl.classList.contains('light-theme');
            // If neither class is set, detect from system
            if (!htmlEl.classList.contains('light-theme') && !htmlEl.classList.contains('dark-theme')) {
                isLight = window.matchMedia('(prefers-color-scheme: light)').matches;
            }

            if (isLight) {
                // Switch to dark
                htmlEl.classList.remove('light-theme');
                htmlEl.classList.add('dark-theme');
                localStorage.setItem('syn-player-theme', 'dark');
            } else {
                // Switch to light
                htmlEl.classList.remove('dark-theme');
                htmlEl.classList.add('light-theme');
                localStorage.setItem('syn-player-theme', 'light');
            }
            updateThemeIcon();
        });
    }

    // Listen for system theme changes (only when no manual preference set)
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', function(e) {
        if (!localStorage.getItem('syn-player-theme')) {
            updateThemeIcon();
        }
    });

    // ============ Navigation ============
    const navbar = document.getElementById('navbar');
    const hamburgerBtn = document.getElementById('hamburgerBtn');
    const navMenu = document.getElementById('navMenu');

    // Navbar scroll effect
    window.addEventListener('scroll', function() {
        if (window.scrollY > 50) {
            navbar.classList.add('scrolled');
        } else {
            navbar.classList.remove('scrolled');
        }
    });

    // Mobile menu toggle
    if (hamburgerBtn) {
        hamburgerBtn.addEventListener('click', function() {
            navMenu.classList.toggle('open');
            const icon = hamburgerBtn.querySelector('i');
            if (navMenu.classList.contains('open')) {
                icon.className = 'fas fa-times';
            } else {
                icon.className = 'fas fa-bars';
            }
        });
    }

    // Inject mobile search toggle button (visible only at ≤992px)
    var navRight = document.querySelector('.nav-right');
    if (navRight) {
        var mobileSearchBtn = document.createElement('button');
        mobileSearchBtn.className = 'search-toggle-mobile';
        mobileSearchBtn.title = '搜索';
        mobileSearchBtn.innerHTML = '<i class="fas fa-search"></i>';
        mobileSearchBtn.addEventListener('click', function() {
            var q = (document.getElementById('searchInput') && document.getElementById('searchInput').value.trim()) || '';
            showSearchOverlay(q || '推荐');
        });
        navRight.insertBefore(mobileSearchBtn, navRight.firstChild);
    }

    // ============ Back to Top Button ============
    var backToTopBtn = document.getElementById('backToTop');
    if (!backToTopBtn) {
        backToTopBtn = document.createElement('button');
        backToTopBtn.id = 'backToTop';
        backToTopBtn.className = 'back-to-top';
        backToTopBtn.title = '返回顶部';
        backToTopBtn.innerHTML = '<i class="fas fa-arrow-up"></i>';
        document.body.appendChild(backToTopBtn);
    }

    // Show back-to-top permanently once mouse passes over trending movies.
    // Hide when clicked (after scrolling to top).
    var trendingMoviesSection = document.getElementById('trendingMovies');

    if (trendingMoviesSection) {
        trendingMoviesSection.addEventListener('mouseenter', function() {
            backToTopBtn.classList.add('visible');
        });
    }

    backToTopBtn.addEventListener('click', function() {
        window.scrollTo({ top: 0, behavior: 'smooth' });
        backToTopBtn.classList.remove('visible');
    });

    // Search input functionality
    var searchInput = document.getElementById('searchInput');
    var searchClear = document.getElementById('searchClear');
    var searchOverlay = document.getElementById('searchOverlay');
    var searchOverlayContent = document.getElementById('searchOverlayContent');
    var searchOverlayQuery = document.getElementById('searchOverlayQuery');
    var searchOverlayClose = document.getElementById('searchOverlayClose');
    var searchOverlayResults = document.getElementById('searchOverlayResults');

    function showSearchOverlay(query) {
        var iconEl = document.querySelector('.search-overlay-icon');
        searchOverlayQuery.textContent = '「' + query + '」';
        if (iconEl) iconEl.style.display = '';
        searchOverlay.classList.add('active');
        document.body.style.overflow = 'hidden';
        // Scroll results to top when new search starts
        if (searchOverlayContent) searchOverlayContent.scrollTop = 0;

        // Show loading state
        searchOverlayResults.innerHTML = '' +
            '<div class="search-no-results">' +
            '  <div class="loading-spinner" style="width:32px;height:32px;border:3px solid var(--border-color);border-top-color:var(--red);border-radius:50%;animation:spin 0.8s linear infinite;margin:0 auto 14px;"></div>' +
            '  <p>正在搜索...</p>' +
            '</div>';

        // Call VOD search API
        fetch('/api/vod/search?wd=' + encodeURIComponent(query))
            .then(function(r) { return r.json(); })
            .then(function(result) {
                if (result.success && result.data && result.data.length > 0) {
                    renderSearchResults(result.data, result.source);
                } else {
                    if (iconEl) iconEl.style.display = '';
                    searchOverlayResults.innerHTML = '' +
                        '<div class="search-no-results">' +
                        '  <i class="fas fa-film"></i>' +
                        '  <p>抱歉，未找到与 <strong>' + query + '</strong> 相关的内容</p>' +
                        '  <p class="search-no-hint">请尝试其他关键词搜索</p>' +
                        '</div>';
                }
            })
            .catch(function() {
                if (iconEl) iconEl.style.display = '';
                searchOverlayResults.innerHTML = '' +
                    '<div class="search-no-results">' +
                    '  <i class="fas fa-film"></i>' +
                    '  <p>搜索服务暂不可用</p>' +
                    '  <p class="search-no-hint">请稍后重试</p>' +
                    '</div>';
            });
    }

    function renderSearchResults(vods, source) {
        // Hide the decorative search icon when results are shown
        var iconEl = document.querySelector('.search-overlay-icon');
        if (iconEl) iconEl.style.display = 'none';
        // Scroll to top of results
        if (searchOverlayContent) searchOverlayContent.scrollTop = 0;

        var sourceLabel = source === 'external' ? '外部资源站' : source === 'local' ? '本地数据库' : '缓存';
        var sourceDotClass = source === 'external' ? 'external' : source === 'local' ? 'local' : 'cache';
        var html = '<div class="vod-search-source">' +
            '<span class="source-dot ' + sourceDotClass + '"></span>' +
            '找到 <span class="vod-search-count">' + vods.length + '</span> 个结果' +
            '<span style="opacity:0.6;">· ' + sourceLabel + '</span>' +
            '</div>';
        html += '<div class="vod-search-grid">';
        vods.forEach(function(v) {
            var title = v.vod_name || v.title || '未知影片';
            var pic = v.vod_pic || v.poster_url || '';
            var remark = v.vod_remarks || '';
            var year = v.vod_year || v.year || '';
            var typeName = v.type_name || v.vod_type || '';
            var rating = v.vod_score || v.douban_rating || '';
            var fallbackSeed = (v.vod_id || Math.random()).toString(36).substring(0, 8);
            html += '<div class="vod-search-card" onclick="location.href=\'video-player.html?id=' + (v.vod_id || v.id) + '\'" title="' + title + '">';
            html += '<img src="' + (pic || '/api/vod/image-proxy?fallback=1') + '" alt="' + title + '" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display=\'none\'">';
            html += '<div class="vod-search-card-body">';
            html += '<div class="vod-search-title">' + title + '</div>';
            html += '<div class="vod-search-meta">';
            if (year) html += '<span class="meta-year">' + year + '</span>';
            if (rating && parseFloat(rating) > 0) html += '<span class="meta-tag">' + parseFloat(rating).toFixed(1) + '</span>';
            if (typeName) html += '<span class="meta-type">' + typeName + '</span>';
            if (remark) html += '<span style="color:var(--red);font-size:11px;">' + remark + '</span>';
            html += '</div></div></div>';
        });
        html += '</div>';
        searchOverlayResults.innerHTML = html;
    }

    function hideSearchOverlay() {
        searchOverlay.classList.remove('active');
        document.body.style.overflow = '';
    }

    if (searchOverlayClose) {
        searchOverlayClose.addEventListener('click', hideSearchOverlay);
        searchOverlay.querySelector('.search-overlay-backdrop').addEventListener('click', hideSearchOverlay);
    }

    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && searchOverlay && searchOverlay.classList.contains('active')) {
            hideSearchOverlay();
        }
    });

    if (searchInput && searchClear) {
        searchInput.addEventListener('input', function() {
            var val = searchInput.value.trim();
            searchClear.style.display = val.length > 0 ? 'flex' : 'none';
            filterContent(val.toLowerCase());
        });

        searchClear.addEventListener('click', function() {
            searchInput.value = '';
            searchClear.style.display = 'none';
            searchInput.focus();
            resetFilter();
        });

        searchInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                var val = searchInput.value.trim();
                if (val) {
                    showSearchOverlay(val);
                    searchInput.blur();
                }
            } else if (e.key === 'Escape') {
                searchInput.value = '';
                searchClear.style.display = 'none';
                searchInput.blur();
                resetFilter();
            }
        });
    }

    function resetFilter() {
        var sections = document.querySelectorAll('.section');
        sections.forEach(function(s) { s.style.display = ''; });
        document.querySelectorAll('.thumb-card').forEach(function(c) { c.style.display = ''; });
        document.querySelectorAll('.no-results-msg').forEach(function(m) { m.remove(); });
    }

    function filterContent(query) {
        resetFilter();
        if (!query) return;

        var sections = document.querySelectorAll('.section');
        var totalVisible = 0;
        sections.forEach(function(section) {
            var cards = section.querySelectorAll('.thumb-card');
            var hasVisible = false;
            cards.forEach(function(card) {
                var title = card.querySelector('.thumb-title');
                if (title && title.textContent.toLowerCase().includes(query)) {
                    card.style.display = '';
                    hasVisible = true;
                    totalVisible++;
                } else {
                    card.style.display = 'none';
                }
            });
            section.style.display = hasVisible ? '' : 'none';
        });

        // Show "no results" inline if nothing matches
        if (totalVisible === 0) {
            var mainContent = document.querySelector('.main-content') || document.querySelector('.news-container') || document.body;
            var msg = document.createElement('div');
            msg.className = 'no-results-msg';
            msg.innerHTML = '<div class="news-loading" style="padding:80px 20px;"><i class="fas fa-search" style="font-size:40px;color:var(--text-muted);display:block;margin-bottom:12px;"></i><p style="color:var(--text-secondary);">没有找到匹配的内容，请尝试其他关键词</p></div>';
            if (mainContent.querySelector('.section')) {
                mainContent.querySelector('.section:first-of-type').insertAdjacentElement('beforebegin', msg);
            }
        }
    }

    // ============ Hero Carousel ============
    // Carousel is loaded dynamically from API — see loadCarousel() above

    // ============ Load Content from API ============
    function renderVideoCard(video, opts) {
        opts = opts || {};
        var useBackdrop = opts.useBackdrop;
        var cardClass = video.is_live ? 'thumb-card channel' : 'thumb-card';
        var rating = parseFloat(video.rating) || parseFloat(video.douban_rating) || 0;
        var badgeText = '';
        var badgeClass = 'thumb-badge';
        if (rating > 0) {
            badgeText = rating.toFixed(1);
        } else if (video.vod_remarks || video.type || video.vod_class) {
            badgeText = video.vod_remarks || video.type || video.vod_class;
            badgeClass = 'thumb-badge secondary';
        }
        var year = video.year || video.vod_year || '';
        var type = video.type || video.vod_class || video.type_name || '';
        var desc = video.description || video.vod_content || '';

        // Richer subtitle — try description snippet first, then fall back to year/genre
        var subtitle = '';
        if (desc && desc.length > 8) {
            subtitle = desc.replace(/<[^>]+>/g, '').replace(/\s+/g, '').substring(0, 30);
        }
        if (!subtitle && year) {
            subtitle = [year, type].filter(Boolean).join(' / ');
        } else if (!subtitle) {
            subtitle = type;
        }

        // Use backdrop (16:9) for landscape sections, poster (2:3) for standard cards
        var imgSrc;
        if (useBackdrop) {
            imgSrc = video.backdrop_url || video.poster_url || '/api/vod/image-proxy?fallback=1';
        } else {
            imgSrc = video.poster_url || '/api/vod/image-proxy?fallback=1';
        }

        var clickUrl = video.series_title ? 'series.html?title=' + encodeURIComponent(video.series_title) : 'video-player.html?id=' + video.id;
        var html = '<div class="' + cardClass + '" onclick="location.href=\'' + clickUrl + '\'">';
        html += '<div class="thumb-poster">';
        html += '<img src="' + imgSrc + '" alt="' + video.title + '" loading="lazy" referrerpolicy="no-referrer">';
        html += '<div style="display:none;width:100%;height:100%;background:linear-gradient(135deg,#1a1a2e,#16213e,#0f3460);align-items:center;justify-content:center;font-size:12px;color:#888;text-align:center;padding:10px;">' + video.title + '</div>';
        if (badgeText) {
            if (rating > 0) {
                html += '<span class="' + badgeClass + '"><i class="fas fa-star" style="font-size:7px;margin-right:2px;"></i>' + badgeText + '</span>';
            } else {
                html += '<span class="' + badgeClass + '">' + badgeText + '</span>';
            }
        }
        html += '<div class="thumb-overlay-hover"><span class="thumb-play-icon"><i class="fas fa-play"></i></span></div>';
        html += '</div>';
        html += '<div class="thumb-info">';
        html += '<div class="thumb-title">' + video.title + '</div>';
        if (video.series_title && video.season_label) {
            html += '<div class="thumb-subtitle" style="color:#e50914;">' + video.season_label + '</div>';
        } else if (subtitle) {
            html += '<div class="thumb-subtitle">' + subtitle + '</div>';
        }
        html += '</div></div>';
        return html;
    }

    // Poster-wall card for 更多推荐 — uniform grid, no cropping
    function renderPosterWallCard(video, index) {
        var rating = parseFloat(video.rating) || parseFloat(video.douban_rating) || 0;
        var badgeText = rating > 0 ? rating.toFixed(1) : '';
        var posterUrl = video.poster_url || video.poster || '';
        var title = video.title || video.vod_name || '';
        var year = video.year || video.vod_year || '';
        var type = video.type || video.vod_class || video.type_name || '';
        var subtitle = [year, type].filter(Boolean).join(' / ') || '';

        var recClickUrl = video.series_title ? 'series.html?title=' + encodeURIComponent(video.series_title) : 'video-player.html?id=' + (video.vod_id || video.id);
        return '<div class="more-recommend-card" data-index="' + index + '" onclick="location.href=\'' + recClickUrl + '\'">' +
            '<img class="poster-img" src="' + (posterUrl || '/api/vod/image-proxy?fallback=1') + '" alt="' + title + '" loading="lazy">' +
            '<div class="poster-overlay">' +
                (badgeText ? '<span class="poster-badge"><i class="fas fa-star"></i> ' + badgeText + '</span>' : '') +
                '<div class="poster-title">' + title + '</div>' +
                (subtitle ? '<div class="poster-subtitle">' + subtitle + '</div>' : '') +
            '</div>' +
        '</div>';
    }

    // Staggered fly-up animation for poster-wall cards — row by row
    function animatePosterWallCards(container) {
        var cards = container.querySelectorAll('.more-recommend-card:not(.visible)');
        if (!cards.length) return;

        var rows = {};
        cards.forEach(function(card) {
            var top = card.getBoundingClientRect().top;
            var rowKey = Math.round(top / 8);
            if (!rows[rowKey]) rows[rowKey] = [];
            rows[rowKey].push(card);
        });

        var rowKeys = Object.keys(rows).sort(function(a, b) { return a - b; });
        rowKeys.forEach(function(key, rowIndex) {
            rows[key].forEach(function(card) {
                setTimeout(function() {
                    card.classList.add('visible');
                }, rowIndex * 120);
            });
        });
    }

    // Global thumb image fallback — show gradient placeholder on error
    window._imgProxyRetry = function(img) {
        img.style.display = 'none';
        if (img.nextElementSibling) img.nextElementSibling.style.display = 'flex';
    };

    // Global hero image fallback — searches for better posters in real-time
    var fallbackTimers = {};
    window._heroImgFallback = function(img) {
        var fid = img.getAttribute('data-fallback-id');
        if (!fid) return;
        // Avoid infinite loops
        if (img.dataset.failedOnce) return;
        img.dataset.failedOnce = '1';
        // Set temporary placeholder
        img.src = 'https://picsum.photos/seed/' + fid + '/300/450';
        // Search for better poster in background
        var title = img.getAttribute('data-title') || '';
        if (!title) return;
        fetch('/api/search-poster?title=' + encodeURIComponent(title))
            .then(function(r) { return r.json(); })
            .then(function(data) {
                if (data.success && data.posters && data.posters.length > 0) {
                    var newSrc = data.posters[0].poster;
                    if (newSrc) {
                        img.src = newSrc;
                        img.dataset.failedOnce = '';
                    }
                }
            }).catch(function() { /* silent */ });
    };

    function buildStarRating(score) {
        var rating = parseFloat(score);
        if (!isFinite(rating)) {
            return '<i class="far fa-star"></i>'.repeat(5);
        }
        var value = Math.min(Math.max(rating / 2, 0), 5);
        var rounded = Math.round(value * 2) / 2;
        var fullStars = Math.floor(rounded);
        var halfStar = rounded - fullStars >= 0.5 ? 1 : 0;
        var emptyStars = 5 - fullStars - halfStar;
        var html = '';
        for (var i = 0; i < fullStars; i++) {
            html += '<i class="fas fa-star"></i>';
        }
        if (halfStar) {
            html += '<i class="fas fa-star-half-alt"></i>';
        }
        for (var j = 0; j < emptyStars; j++) {
            html += '<i class="far fa-star"></i>';
        }
        return html;
    }

    function getContentSegment(video) {
        var label = (video.rankLabel || video.listTitle || video.category || video.type || video.vod_class || '').toString();
        var text = label.toLowerCase();
        if (/纪录|记录/.test(text)) return 'documentary';
        if (/动漫|动画/.test(text)) return 'anime';
        if (/剧|电视剧|韩剧|日剧|泰剧|网剧|电视剧/.test(text) || /综艺/.test(text)) return 'tv';
        return 'movie';
    }

    function getListLabel(videoSegment) {
        switch (videoSegment) {
            case 'tv': return '电视剧推荐';
            case 'documentary': return '纪录片推荐';
            case 'anime': return '动漫推荐';
            default: return '电影推荐';
        }
    }

    // Load carousel using Swiper.js — immersive single-poster design
    function loadCarousel() {
        // Only show manually featured videos — no algorithmic selection
        fetch('/api/videos?featured=1').then(function(r) { return r.json(); }).then(function(videos) {
            var wrapper = document.getElementById('swiperWrapper');
            if (!wrapper) return;

            if (!videos || !videos.length) {
                // No featured videos — hide carousel section or show placeholder
                var section = document.querySelector('.hero-carousel');
                if (section) section.style.display = 'none';
                return;
            }

            var section = document.querySelector('.hero-carousel');
            if (section) section.style.display = '';

            var cards = videos.slice(0, 12); // Allow up to 12 featured
            var slidesHTML = cards.map(function(v, i) {
                var poster = v.backdrop_url || v.poster_url || v.poster || v.vod_pic || 'https://picsum.photos/seed/c' + i + '/1400/800';
                var title = v.title || v.vod_name || '未知影片';
                var rating = v.rating || '';
                var type = v.type || v.vod_class || v.type_name || '';
                var year = v.year || v.vod_year || v.release_year || '';
                var releaseDate = v.release_date || '';
                var area = v.vod_area || v.area || '';
                var duration = v.duration || '';
                // Format duration: "120 min" → "2小时0分钟", "3 seasons" → "3季"
                var durationDisplay = '';
                if (duration) {
                    var minMatch = duration.match(/(\d+)\s*min/i);
                    var seasonMatch = duration.match(/(\d+)\s*season/i);
                    if (minMatch) {
                        var mins = parseInt(minMatch[1]);
                        var h = Math.floor(mins / 60);
                        var m = mins % 60;
                        durationDisplay = h > 0 ? h + '小时' + (m > 0 ? m + '分钟' : '') : m + '分钟';
                    } else if (seasonMatch) {
                        durationDisplay = seasonMatch[1] + '季';
                    } else {
                        durationDisplay = duration;
                    }
                }
                var genre = v.genre || v.vod_type || '';
                var desc = v.description || v.plot || v.vod_content || '';
                var id = v.id || v.vod_id || '';
                var ratingFloat = parseFloat(rating);
                var ratingValue = isFinite(ratingFloat) && ratingFloat > 0 ? rating : '暂无';
                var ratingSourceLabel = v.rating_source || '';
                if (ratingSourceLabel && ratingValue !== '暂无') ratingSourceLabel += ' ';

                // Format release date: "上映时间：YYYY年-MM月 (地区) 影片类型 时长"
                var dateDisplay = '';
                if (releaseDate && releaseDate.length >= 4) {
                    var parts = releaseDate.split('-');
                    if (parts.length >= 2) {
                        dateDisplay = parts[0] + '年-' + String(parseInt(parts[1])).padStart(2, '0') + '月';
                    }
                }
                if (!dateDisplay && year && year.length === 4) {
                    dateDisplay = year + '年';
                }

                var metaParts = [];
                if (dateDisplay) metaParts.push('上映时间：' + dateDisplay);
                else if (year) metaParts.push('上映时间：' + year + '年');
                if (area) metaParts.push('(' + area + ')');
                if (type) metaParts.push(type);
                if (durationDisplay) metaParts.push(durationDisplay);
                var meta = metaParts.join('  ');

                var html = '';
                html += '<div class="swiper-slide">';
                html += '<div class="hero-immersive">';
                html += '<div class="hero-bg" style="background-image: url(\'' + poster + '\')" data-orig-bg="' + poster.replace(/"/g, '&quot;') + '"></div>';
                html += '<div class="hero-hover-glow"></div>';
                html += '<div class="hero-info">';
                html += '<span class="hero-label">今日推荐</span>';
                html += '<div class="hero-tag-row">';
                html += '<span class="hero-rank">No.' + (i + 1) + ' 精选推荐</span>';
                html += '<span class="hero-score">' + ratingSourceLabel + ratingValue + ' / 10</span>';
                html += '</div>';
                html += '<div class="hero-rating-row">';
                html += '<span class="hero-rating-stars">' + buildStarRating(rating) + '</span>';
                html += '<span class="hero-rating-value">' + ratingValue + '</span>';
                html += '</div>';
                html += '<h1 class="hero-title">' + title + '</h1>';
                html += '<h2 class="hero-subtitle">' + meta + '</h2>';
                if (desc) {
                    var short = desc.length > 240 ? desc.substr(0, 240) + '…' : desc;
                    html += '<p class="hero-desc">' + short + '</p>';
                }
                html += '<div class="hero-actions">';
                html += '<button class="btn-play-hero" onclick="location.href=\'video-player.html?id=' + id + '\'">立即播放</button>';
                html += '<button class="btn-add-list-hero">加入列表</button>';
                html += '</div></div></div></div>';
                return html;
            }).join('');

            wrapper.innerHTML = slidesHTML;

            if (window.mySwiper) {
                try { window.mySwiper.destroy(true, true); } catch (e) {}
            }

            window.mySwiper = new Swiper('.hero-carousel .swiper', {
                slidesPerView: 1,
                spaceBetween: 0,
                loop: true,
                autoplay: { delay: 5000, disableOnInteraction: false },
                effect: 'slide',
                pagination: { el: '.swiper-pagination', clickable: true },
                navigation: { nextEl: '.swiper-button-next', prevEl: '.swiper-button-prev' },
                grabCursor: true,
                keyboard: { enabled: true },
            });
            try { setupHeroInteractions(); } catch(e) {}
            try { fixCarouselBg(); } catch(e) {}
        }).catch(function() {
            var section = document.querySelector('.hero-carousel');
            if (section) section.style.display = 'none';
        });
    }

    // Detect broken carousel background images and fall back to picsum
    function fixCarouselBg() {
        var slides = document.querySelectorAll('.hero-bg[data-orig-bg]');
        slides.forEach(function(slide) {
            var origBg = slide.getAttribute('data-orig-bg');
            if (!origBg) return;
            var testImg = new Image();
            testImg.onerror = function() {
                if (slide.dataset.bgFixed) return;
                slide.dataset.bgFixed = '1';
                slide.style.backgroundImage = 'url(https://picsum.photos/seed/' + encodeURIComponent(origBg.slice(-20)) + '/1400/800)';
            };
            testImg.src = origBg;
        });
    }

    // Setup interactions: hover to pause, no parallax (zoom handled by CSS)
    function setupHeroInteractions() {
        var container = document.querySelector('.hero-carousel .swiper');
        if (!container || !window.mySwiper) return;

        container.addEventListener('mouseenter', function() {
            try { window.mySwiper.autoplay && window.mySwiper.autoplay.pause(); } catch (e) {}
        });
        container.addEventListener('mouseleave', function() {
            try { window.mySwiper.autoplay && window.mySwiper.autoplay.resume(); } catch (e) {}
        });
    }

    // Load section thumbnails
    var moreRecommendData = [];
    var moreRecommendLoaded = 0;
    var moreRecommendLoadCount = 0;
    var MORE_RECOMMEND_MAX_LOADS = 4;
    var MORE_RECOMMEND_BATCH = 40;

    function loadSections() {
        // Phase 1: Load the 4 main sections in parallel, track shown vod_ids
        var mainSections = ['trendingMovies', 'trendingTV', 'trendingAnime', 'trendingVariety', 'liveTV'];
        var shownIds = new Set();

        var mainPromises = mainSections.map(function(sectionId) {
            var container = document.getElementById(sectionId);
            if (!container) return Promise.resolve();
            return fetch('/api/videos?category=' + sectionId).then(function(r) { return r.json(); }).then(function(videos) {
                if (!videos.length) { container.innerHTML = '<p style="color:#999;padding:20px;">暂无内容</p>'; return; }
                // Store for tab sorting
                if (sectionId === 'trendingMovies') {
                    trendingData = videos.slice();
                } else if (sectionId === 'trendingTV') {
                    trendingTVData = videos.slice();
                } else if (sectionId === 'trendingAnime') {
                    trendingAnimeData = videos.slice();
                } else if (sectionId === 'trendingVariety') {
                    trendingVarietyData = videos.slice();
                }
                var limit = (sectionId === 'liveTV' || sectionId === 'trendingVariety') ? 6 : 12;
                var useBackdrop = sectionId === 'trendingMovies' || sectionId === 'trendingTV' || sectionId === 'trendingAnime' || sectionId === 'trendingVariety';
                var rendered = videos.slice(0, limit);
                // Only track actually-rendered IDs so moreRecommend still has items to show
                rendered.forEach(function(v) { shownIds.add(String(v.vod_id || v.id)); });
                container.innerHTML = rendered.map(function(v) { return renderVideoCard(v, { useBackdrop: useBackdrop }); }).join('');
            }).catch(function() {
                container.innerHTML = '<p style="color:#999;padding:20px;">加载失败</p>';
            });
        });

        // Phase 2: After main sections load, load moreRecommend excluding shown IDs
        Promise.all(mainPromises).then(function() {
            var container = document.getElementById('moreRecommend');
            if (!container) return;
            fetch('/api/videos?category=moreRecommend').then(function(r) { return r.json(); }).then(function(videos) {
                var filtered = videos.filter(function(v) { return !shownIds.has(String(v.vod_id || v.id)); });
                // Fallback: if no moreRecommend videos, load from VOD search as well
                if (filtered.length < 6) {
                    return fetch('/api/vod/search?wd=&limit=48').then(function(r) { return r.json(); }).then(function(vodData) {
                        var vods = (vodData.data || []).filter(function(v) { return !shownIds.has(String(v.vod_id || v.id)); });
                        // Merge: local videos first, then VODs
                        filtered = filtered.concat(vods);
                        return filtered;
                    });
                }
                return filtered;
            }).then(function(filtered) {
                if (!filtered.length) { container.innerHTML = '<p style="color:#999;padding:20px;">暂无更多推荐</p>'; return; }
                moreRecommendData = filtered.slice();
                moreRecommendLoaded = Math.min(MORE_RECOMMEND_BATCH, filtered.length);
                moreRecommendLoadCount = 0;
                container.innerHTML = filtered.slice(0, MORE_RECOMMEND_BATCH).map(function(v, i) { return renderPosterWallCard(v, i); }).join('');
                setTimeout(function() { animatePosterWallCards(container); }, 200);
                setupMoreRecommendObserver();
            }).catch(function() {
                container.innerHTML = '<p style="color:#999;padding:20px;">加载失败</p>';
            });
        });
    }

    function setupMoreRecommendObserver() {
        var sentinel = document.getElementById('moreRecommendSentinel');
        var container = document.getElementById('moreRecommend');
        if (!sentinel || !container) return;

        var observer = new IntersectionObserver(function(entries) {
            if (!entries[0].isIntersecting) return;
            if (moreRecommendLoadCount >= MORE_RECOMMEND_MAX_LOADS) return;
            if (moreRecommendLoaded >= moreRecommendData.length) {
                observer.disconnect();
                return;
            }

            var next = moreRecommendData.slice(moreRecommendLoaded, moreRecommendLoaded + MORE_RECOMMEND_BATCH);
            var startIndex = moreRecommendLoaded;
            container.insertAdjacentHTML('beforeend', next.map(function(v, i) { return renderPosterWallCard(v, startIndex + i); }).join(''));
            moreRecommendLoaded += MORE_RECOMMEND_BATCH;
            moreRecommendLoadCount++;
            setTimeout(function() { animatePosterWallCards(container); }, 100);

            if (moreRecommendLoaded >= moreRecommendData.length || moreRecommendLoadCount >= MORE_RECOMMEND_MAX_LOADS) {
                observer.disconnect();
            }
        }, { rootMargin: '200px' });

        observer.observe(sentinel);
    }

    // ============ Trending Section Tabs (iQiyi-style) ============
    var trendingData = [];
    var trendingTVData = [];
    var trendingAnimeData = [];
    var trendingVarietyData = [];

    var sectionDataMap = {
        'trendingMovies': function() { return trendingData; },
        'trendingTV': function() { return trendingTVData; },
        'trendingAnime': function() { return trendingAnimeData; },
        'trendingVariety': function() { return trendingVarietyData; }
    };

    document.querySelectorAll('.section-tabs').forEach(function(tabsWrap) {
        var section = tabsWrap.closest('.section-trending-iqiyi');
        var grid = section ? section.querySelector('.thumb-grid') : null;
        if (!grid) return;
        var sectionId = grid.id;

        tabsWrap.querySelectorAll('.section-tab').forEach(function(tab) {
            tab.addEventListener('click', function() {
                var getData = sectionDataMap[sectionId];
                if (!getData) return;
                var data = getData();
                if (!data.length) return;

                // Only update tabs within this section
                tabsWrap.querySelectorAll('.section-tab').forEach(function(t) { t.classList.remove('active'); });
                this.classList.add('active');

                var mode = this.dataset.tab;
                var sorted = data.slice();
                if (mode === 'hot') {
                    sorted.sort(function(a, b) { return (parseFloat(b.rating) || 0) - (parseFloat(a.rating) || 0); });
                } else if (mode === 'new') {
                    sorted.sort(function(a, b) { return (parseInt(b.year || b.vod_year) || 0) - (parseInt(a.year || a.vod_year) || 0); });
                }
                grid.innerHTML = sorted.slice(0, 12).map(function(v) { return renderVideoCard(v, { useBackdrop: true }); }).join('');
            });
        });
    });

    loadCarousel();
    loadSections();

    // ============ Scroll Arrows for all iQiyi-style sections ============
    function setupAllScrollArrows() {
        var wraps = document.querySelectorAll('.section-trending-iqiyi .thumb-scroll-wrap');
        wraps.forEach(function(wrap) {
            var row = wrap.querySelector('.thumb-row');
            var leftBtn = wrap.querySelector('.thumb-scroll-left');
            var rightBtn = wrap.querySelector('.thumb-scroll-right');
            if (!row || !leftBtn || !rightBtn) return;

            function checkOverflow() {
                var overflow = row.scrollWidth > row.clientWidth + 2;
                if (overflow) {
                    leftBtn.classList.add('visible');
                    rightBtn.classList.add('visible');
                } else {
                    leftBtn.classList.remove('visible');
                    rightBtn.classList.remove('visible');
                }
            }

            function scrollBy(direction) {
                var card = row.querySelector('.thumb-card');
                if (!card) return;
                var cardWidth = card.getBoundingClientRect().width;
                var gap = 16;
                var scrollAmount = (cardWidth + gap) * 2;
                row.scrollBy({
                    left: direction === 'left' ? -scrollAmount : scrollAmount,
                    behavior: 'smooth'
                });
            }

            leftBtn.addEventListener('click', function() { scrollBy('left'); });
            rightBtn.addEventListener('click', function() { scrollBy('right'); });

            checkOverflow();
            window.addEventListener('resize', checkOverflow);

            row.querySelectorAll('img').forEach(function(img) {
                img.addEventListener('load', checkOverflow);
            });

            var observer = new MutationObserver(function() { setTimeout(checkOverflow, 100); });
            observer.observe(row, { childList: true, subtree: false });
        });
    }

    setTimeout(setupAllScrollArrows, 600);

    // ============ Like / Dislike Buttons ============
    var likeBtn = document.getElementById('likeBtn');
    var dislikeBtn = document.getElementById('dislikeBtn');

    if (likeBtn) {
        likeBtn.addEventListener('click', function() {
            this.classList.toggle('liked');
            var icon = this.querySelector('i');
            if (this.classList.contains('liked')) {
                icon.className = 'fas fa-thumbs-up';
            } else {
                icon.className = 'far fa-thumbs-up';
            }
            if (dislikeBtn && dislikeBtn.classList.contains('liked')) {
                dislikeBtn.classList.remove('liked');
                dislikeBtn.querySelector('i').className = 'far fa-thumbs-down';
            }
        });
    }

    if (dislikeBtn) {
        dislikeBtn.addEventListener('click', function() {
            this.classList.toggle('liked');
            var icon = this.querySelector('i');
            if (this.classList.contains('liked')) {
                icon.className = 'fas fa-thumbs-down';
            } else {
                icon.className = 'far fa-thumbs-down';
            }
            if (likeBtn && likeBtn.classList.contains('liked')) {
                likeBtn.classList.remove('liked');
                likeBtn.querySelector('i').className = 'far fa-thumbs-up';
            }
        });
    }

    // ============ Related Videos Sidebar ============
    // Video player page has dedicated related rendering logic in video-player.html.
    var relatedList = document.getElementById('relatedList');
    var relatedGrid = document.getElementById('relatedGrid');
    var currentVideoId = new URLSearchParams(window.location.search).get('id');
    if (relatedList && !relatedGrid) {
        fetch('/api/videos').then(function(r) { return r.json(); }).then(function(videos) {
            // Filter out current video, show up to 10 random related
            var related = videos.filter(function(v) { return String(v.id) !== String(currentVideoId); });
            related = related.sort(function() { return Math.random() - 0.5; }).slice(0, 10);
            var html = '';
            related.forEach(function(v) {
                html += '<div class="related-item" onclick="location.href=\'video-player.html?id=' + v.id + '\'">';
                html += '<img src="' + (v.poster_url || 'https://picsum.photos/seed/rel' + v.id + '/280/160') + '" alt="' + v.title + '" loading="lazy">';
                html += '<div class="related-item-info">';
                html += '<h5>' + v.title + '</h5>';
                html += '<span>' + (v.duration || v.year || '') + '</span>';
                html += '</div></div>';
            });
            relatedList.innerHTML = html;
        }).catch(function() {
            relatedList.innerHTML = '<p style="color:#999;padding:10px;">加载失败</p>';
        });
    }

});

