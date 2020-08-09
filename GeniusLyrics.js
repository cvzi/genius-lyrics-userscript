// ==UserScript==
// @exclude      *
// ==UserLibrary==
// @name         GeniusLyrics
// @description  Downloads and shows genius lyrics for Tampermonkey scripts
// @version      3
// @license      GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt
// @copyright    2020, cuzi (https://github.com/cvzi)
// @supportURL   https://github.com/cvzi/GeniusLyricsUserscriptLibrary/issues
// ==/UserLibrary==
// @homepageURL  https://github.com/cvzi/GeniusLyricsUserscriptLibrary
// @grant        GM.xmlHttpRequest
// @grant        GM.getValue
// @grant        GM.setValue
// @connect      genius.com
// ==/UserScript==

// TODO save scroll speed global and per song
// TODO pause button for instrumental parts

/* global Reflect */

if (typeof module !== 'undefined') {
  module.exports = geniusLyrics
}

function geniusLyrics (custom) { // eslint-disable-line no-unused-vars
  'use strict'

  Array.prototype.forEach.call([
    'GM',
    'scriptName',
    'domain',
    'emptyURL',
    'listSongs',
    'showSearchField',
    'addLyrics',
    'hideLyrics',
    'getCleanLyricsContainer',
    'setFrameDimensions'
  ], function (valName) {
    if (!(valName in custom)) {
      window.alert(`geniusLyrics requires parameter ${valName}`)
      throw new Error(`geniusLyrics requires parameter ${valName}`)
    }
  })

  const genius = {
    option: {
      autoShow: true,
      resizeOnNextRun: false,
      themeKey: null
    },
    f: {
      metricPrefix: metricPrefix,
      showLyrics: showLyrics,
      loadLyrics: loadLyrics,
      rememberLyricsSelection: rememberLyricsSelection,
      getLyricsSelection: getLyricsSelection,
      geniusSearch: geniusSearch,
      searchByQuery: searchByQuery
    },
    current: {
      title: '',
      artists: ''
    },
    iv: {
      main: null
    }
  }

  var requestCache = {}
  var selectionCache = {}
  var theme
  var annotationsEnabled = true
  var onMessage = []

  function getHostname (url) {
    const a = document.createElement('a')
    a.href = url
    return a.hostname
  }

  function removeIfExists (e) {
    if (e && e.remove) {
      e.remove()
    }
  }

  function removeTagsKeepText (node) {
    while (node.firstChild) {
      if ('tagName' in node.firstChild && node.firstChild.tagName !== 'BR') {
        removeTagsKeepText(node.firstChild)
      } else {
        node.parentNode.insertBefore(node.firstChild, node)
      }
    }
    node.remove()
  }

  function decodeHTML (s) {
    return ('' + s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  }

  function metricPrefix (n, decimals, k) {
  // http://stackoverflow.com/a/18650828
    if (n <= 0) {
      return String(n)
    }
    k = k || 1000
    const dm = decimals <= 0 ? 0 : decimals || 2
    const sizes = ['', 'K', 'M', 'G', 'T', 'P', 'E', 'Z', 'Y']
    const i = Math.floor(Math.log(n) / Math.log(k))
    return parseFloat((n / Math.pow(k, i)).toFixed(dm)) + sizes[i]
  }

  function parsePreloadedStateData (obj, parent) {
  // Convert genius' JSON represenation of lyrics to DOM object
    if ('children' in obj) {
      obj.children.forEach(function (child) {
        if (typeof (child) === 'string') {
          if (child) {
            parent.appendChild(document.createTextNode(child))
          }
        } else {
          const node = parent.appendChild(document.createElement(child.tag))
          if ('data' in child) {
            for (const key in child.data) {
              node.dataset[key] = child.data[key]
            }
          }
          if ('attributes' in child) {
            for (const attr in child.attributes) {
              let value = child.attributes[attr]
              if ((attr === 'href' || attr === 'src') && (!value.startsWith('http') && !value.startsWith('#'))) {
                value = 'https://genius.com' + value
              }
              node.setAttribute(attr, value)
            }
          }
          parsePreloadedStateData(child, node)
        }
      })
    }
    return parent
  }

  function loadCache () {
    Promise.all([
      custom.GM.getValue('selectioncache', '{}'),
      custom.GM.getValue('requestcache', '{}'),
      custom.GM.getValue('optionautoshow', true)
    ]).then(function (values) {
      selectionCache = JSON.parse(values[0])

      requestCache = JSON.parse(values[1])

      genius.option.autoShow = values[2] === true || values[2] === 'true'
      /*
    requestCache = {
       "cachekey0": "121648565.5\njsondata123",
       ...
       }
    */
      const now = (new Date()).getTime()
      const exp = 2 * 60 * 60 * 1000
      for (const prop in requestCache) {
      // Delete cached values, that are older than 2 hours
        const time = requestCache[prop].split('\n')[0]
        if ((now - (new Date(time)).getTime()) > exp) {
          delete requestCache[prop]
        }
      }
    })
  }

  function invalidateRequestCache (obj) {
    const cachekey = JSON.stringify(obj)
    if (cachekey in requestCache) {
      delete requestCache[cachekey]
    }
  }

  function request (obj) {
    const cachekey = JSON.stringify(obj)
    if (cachekey in requestCache) {
      return obj.load(JSON.parse(requestCache[cachekey].split('\n')[1]))
    }

    let headers = {
      Referer: obj.url,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Host: getHostname(obj.url),
      'User-Agent': navigator.userAgent
    }
    if (obj.headers) {
      headers = Object.assign(headers, obj.headers)
    }

    return custom.GM.xmlHttpRequest({
      url: obj.url,
      method: obj.method ? obj.method : 'GET',
      data: obj.data,
      headers: headers,
      onerror: obj.error ? obj.error : function xmlHttpRequestGenericOnError (response) { console.log('xmlHttpRequestGenericOnError: ' + response) },
      onload: function xmlHttpRequestOnLoad (response) {
        const time = (new Date()).toJSON()
        // Chrome fix: Otherwise JSON.stringify(requestCache) omits responseText
        var newobj = {}
        for (var key in response) {
          newobj[key] = response[key]
        }
        newobj.responseText = response.responseText
        requestCache[cachekey] = time + '\n' + JSON.stringify(newobj)

        custom.GM.setValue('requestcache', JSON.stringify(requestCache))

        obj.load(response)
      }
    })
  }

  function rememberLyricsSelection (title, artists, jsonHit) {
    const cachekey = title + '--' + artists
    selectionCache[cachekey] = jsonHit
    custom.GM.setValue('selectioncache', JSON.stringify(selectionCache))
  }

  function forgetLyricsSelection (title, artists) {
    const cachekey = title + '--' + artists
    if (cachekey in selectionCache) {
      delete selectionCache[cachekey]
      custom.GM.setValue('selectioncache', JSON.stringify(selectionCache))
    }
  }

  function getLyricsSelection (title, artists) {
    const cachekey = title + '--' + artists
    if (cachekey in selectionCache) {
      return JSON.parse(selectionCache[cachekey])
    } else {
      return false
    }
  }

  function geniusSearch (query, cb) {
    const requestObj = {
      url: 'https://genius.com/api/search/song?page=1&q=' + encodeURIComponent(query),
      headers: {
        'X-Requested-With': 'XMLHttpRequest'
      },
      error: function geniusSearchOnError (response) {
        window.alert(custom.scriptName + '\n\nError geniusSearch(' + JSON.stringify(query) + ', ' + ('name' in cb ? cb.name : 'cb') + '):\n' + response)
        invalidateRequestCache(requestObj)
      },
      load: function geniusSearchOnLoad (response) {
        let jsonData = null
        try {
          jsonData = JSON.parse(response.responseText)
        } catch (e) {
          window.alert(custom.scriptName + '\n\n' + e + ' in geniusSearch(' + JSON.stringify(query) + ', ' + ('name' in cb ? cb.name : 'cb') + '):\n\n' + response.responseText)
          invalidateRequestCache(requestObj)
        }
        if (jsonData !== null) {
          cb(jsonData)
        }
      }
    }
    request(requestObj)
  }

  function loadGeniusSong (song, cb) {
    request({
      url: song.result.url,
      error: function loadGeniusSongOnError (response) {
        window.alert(custom.scriptName + '\n\nError loadGeniusSong(' + JSON.stringify(song) + ', cb):\n' + response)
      },
      load: function loadGeniusSongOnLoad (response) {
        cb(response.responseText)
      }
    })
  }

  function loadGeniusAnnotations (song, html, annotationsEnabled, cb) {
    if (!annotationsEnabled) {
      return cb(song, html, {})
    }
    const regex = /annotation-fragment="\d+"/g
    let m = html.match(regex)
    if (!m) {
      m = html.match(/href="\/\d+\//g)
      if (!m) {
      // No annotations in source -> skip loading annotations from API
        return cb(song, html, {})
      }
    }

    m = m.map((s) => s.match(/\d+/)[0])
    const ids = m.map((id) => 'ids[]=' + id)

    const apiurl = 'https://genius.com/api/referents/multi?text_format=html%2Cplain&' + ids.join('&')

    request({
      url: apiurl,
      headers: {
        'X-Requested-With': 'XMLHttpRequest'
      },
      error: function loadGeniusAnnotationsOnError (response) {
        window.alert(custom.scriptName + '\n\nError loadGeniusAnnotations(' + JSON.stringify(song) + ', cb):\n' + response)
        cb(song, html, {})
      },
      load: function loadGeniusAnnotationsOnLoad (response) {
        const r = JSON.parse(response.responseText).response
        const annotations = {}
        if (r.referents.forEach) {
          r.referents.forEach(function forEachReferent (referent) {
            referent.annotations.forEach(function forEachAnnotation (annotation) {
              if (annotation.referent_id in annotations) {
                annotations[annotation.referent_id].push(annotation)
              } else {
                annotations[annotation.referent_id] = [annotation]
              }
            })
          })
        } else {
          for (const refId in r.referents) {
            const referent = r.referents[refId]
            referent.annotations.forEach(function forEachAnnotation (annotation) {
              if (annotation.referent_id in annotations) {
                annotations[annotation.referent_id].push(annotation)
              } else {
                annotations[annotation.referent_id] = [annotation]
              }
            })
          }
        }
        cb(song, html, annotations)
      }
    })
  }

  const themes = {
    genius: {
      name: 'Genius (Default)',
      scripts: function themeGeniusScripts () {
        const onload = []

        // Define globals
        var annotations1234

        // Hide footer
        function hideFooter895 () {
          const f = document.querySelectorAll('.footer div')
          if (f.length) {
            removeIfExists(f[0])
            removeIfExists(f[1])
          }
        }
        function hideSecondaryFooter895 () {
          if (document.querySelector('.footer.footer--secondary')) {
            document.querySelector('.footer.footer--secondary').parentNode.removeChild(document.querySelector('.footer.footer--secondary'))
          }
        }

        onload.push(hideFooter895)
        onload.push(hideSecondaryFooter895)

        // Hide other stuff
        function hideStuff235 () {
          const grayBox = document.querySelector('.column_layout-column_span-initial_content>.dfp_unit.u-x_large_bottom_margin.dfp_unit--in_read')
          removeIfExists(grayBox)
          removeIfExists(document.querySelector('.header .header-expand_nav_menu'))
        }
        onload.push(hideStuff235)

        // Maked header wider
        onload.push(function () {
          const headerCol = document.querySelector('.header_with_cover_art-inner.column_layout .column_layout-column_span--primary')
          if (headerCol) {
            headerCol.style.width = '100%'
          }
        })

        // Show annotations function
        function checkAnnotationHeight458 () {
          const annot = document.querySelector('.song_body.column_layout .column_layout-column_span.column_layout-column_span--secondary .column_layout-flex_column-fill_column')
          const arrow = annot.querySelector('.annotation_sidebar_arrow')
          if (arrow.offsetTop > arrow.nextElementSibling.clientHeight) {
            arrow.nextElementSibling.style.paddingTop = (10 + parseInt(arrow.nextElementSibling.style.paddingTop) + arrow.offsetTop - arrow.nextElementSibling.clientHeight) + 'px'
          }
        }
        function showAnnotation1234 (ev) {
          ev.preventDefault()
          const id = this.dataset.annotationid
          document.querySelectorAll('.song_body-lyrics .referent--yellow.referent--highlighted').forEach(function (e) {
            e.className = e.className.replace(/\breferent--yellow\b/, '').replace(/\breferent--highlighted\b/, '')
          })
          this.className += ' referent--yellow referent--highlighted'
          if (typeof annotations1234 === 'undefined') {
            if (document.getElementById('annotationsdata1234')) {
              annotations1234 = JSON.parse(document.getElementById('annotationsdata1234').innerHTML)
            } else {
              annotations1234 = {}
              console.log('No annotation data found #annotationsdata1234')
            }
          }
          if (id in annotations1234) {
            const annotation = annotations1234[id][0]
            const main = document.querySelector('.song_body.column_layout .column_layout-column_span.column_layout-column_span--secondary')
            main.style.paddingRight = 0
            main.innerHTML = ''
            const div0 = document.createElement('div')
            div0.className = 'column_layout-flex_column-fill_column'
            main.appendChild(div0)
            const arrowTop = this.offsetTop
            const paddingTop = window.scrollY - main.offsetTop - main.parentNode.offsetTop
            let html = '<div class="annotation_sidebar_arrow" style="top: ' + arrowTop + 'px;"><svg src="left_arrow.svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10.87 21.32"><path d="M9.37 21.32L0 10.66 9.37 0l1.5 1.32-8.21 9.34L10.87 20l-1.5 1.32"></path></svg></div>'
            html += '\n<div class="u-relative nganimate-fade_slide_from_left" style="margin-left:1px;padding-top:' + paddingTop + 'px; padding-left:2px; border-left:3px #99a7ee solid"><div class="annotation_label">$author</div><div class="rich_text_formatting">$body</div></div>'
            html = html.replace(/\$body/g, decodeHTML(annotation.body.html)).replace(/\$author/g, decodeHTML(annotation.created_by.name))
            div0.innerHTML = html
            targetBlankLinks145() // Change link target to _blank
            window.setTimeout(checkAnnotationHeight458, 200) // Change link target to _blank
          }
        }
        onload.push(function () {
          if (document.getElementById('annotationsdata1234')) {
            annotations1234 = JSON.parse(document.getElementById('annotationsdata1234').innerHTML)
          }
        })

        // Make song title clickable
        function clickableTitle037 () {
          const url = document.querySelector('meta[property="og:url"]').content
          const h1 = document.querySelector('.header_with_cover_art-primary_info-title')
          const div = document.querySelector('.header_with_cover_art-cover_art .cover_art')
          if (!h1 || !div) {
            return
          }
          h1.innerHTML = '<a target="_blank" href="' + url + '" style="color:#ffff64">' + h1.innerHTML + '</a>'
          div.innerHTML = '<a target="_blank" href="' + url + '">' + div.innerHTML + '</a>'
        }
        onload.push(clickableTitle037)

        // Change links to target=_blank
        function targetBlankLinks145 () {
          const as = document.querySelectorAll('body a:not([href|="#"]):not([target=_blank])')
          as.forEach(function (a) {
            a.target = '_blank'
          })
        }
        onload.push(() => window.setTimeout(targetBlankLinks145, 1000))

        if (!annotationsEnabled) {
        // Remove all annotations
          onload.push(function removeAnnotations135 () {
            document.querySelectorAll('.song_body-lyrics .referent').forEach(function (a) {
              while (a.firstChild) {
                a.parentNode.insertBefore(a.firstChild, a)
              }
              a.remove()
            })
            // Remove right column
            document.querySelector('.song_body.column_layout .column_layout-column_span--secondary').remove()
            document.querySelector('.song_body.column_layout .column_layout-column_span--primary').style.width = '100%'
          })
        } else {
        // Add click handler to annotations
          document.querySelectorAll('*[data-annotationid]').forEach((a) => a.addEventListener('click', showAnnotation1234))
        }

        // Open real page if not in frame
        onload.push(function () {
          if (window.top === window) {
            document.location.href = document.querySelector('meta[property="og:url"]').content
          }
        })
        return onload
      },
      combine: function themeGeniusCombineGeniusResources (song, html, annotations, cb) {
        let headhtml = ''

        // Make annotations clickable
        const regex = /annotation-fragment="(\d+)"/g
        html = html.replace(regex, '$0 data-annotationid="$1"')

        // Change design
        html = html.split('<div class="leaderboard_ad_container">').join('<div class="leaderboard_ad_container" style="width:0px;height:0px">')

        // Remove cookie consent
        html = html.replace(/<script defer="true" src="https:\/\/cdn.cookielaw.org.+?"/, '<script ')

        // Add annotation data
        headhtml += '\n<script id="annotationsdata1234" type="application/json">' + JSON.stringify(annotations).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</script>'

        // Scrollbar colors
        const bodyWidth = document.getElementById('lyricsiframe').style.width || (document.getElementById('lyricsiframe').getClientRects()[0].width + 'px')
        headhtml += `<style>
        body{
          max-width: ${bodyWidth};
          overflow-x: hidden;
        }
        html{
          background-color:#181818;
          scrollbar-color:hsla(0,0%,100%,.3) transparent;
          scrollbar-width:auto;
        }
        </style>`

        // Add to <head>
        const parts = html.split('</head>')
        html = parts[0] + '\n' + headhtml + '\n</head>' + parts.slice(1).join('</head>')
        return cb(html)
      }
    },
    geniusReact: {
      name: 'Genius React',
      scripts: function themeGeniusReactScripts () {
        const onload = []

        // Define globals
        var annotations1234

        function hideStuff () {
        // Hide "This is a work in progress"
          removeIfExists(document.getElementById('top'))
          // Header leaderboard/nav
          removeIfExists(document.querySelector('div[class^="Leaderboard"]'))
          removeIfExists(document.querySelector('div[class^="StickyNav"]'))
          // Footer except copyright hint
          let not = false
          document.querySelectorAll('div[class^="PageGriddesktop"] div[class^="PageFooterdesktop"]').forEach(function (div) {
            if (!not && div.innerHTML.indexOf('©') === -1) {
              div.remove()
            } else {
              not = true
            }
          })
          document.querySelectorAll('div[class^="PageGriddesktop"]').forEach(function (div) {
            div.className = ''
          })
          // Ads
          document.querySelectorAll('div[class^="InreadAd__Container"]').forEach(function (div) {
            div.parentNode.remove()
          })
          document.querySelectorAll('div[class^="SidebarAd__Container"]').forEach(function (div) {
            div.parentNode.remove()
          })
        }

        // Make song title clickable
        function clickableTitle037 () {
          const url = document.querySelector('meta[property="og:url"]').content
          const h1 = document.querySelector('h1[class^="SongHeader"]')
          h1.innerHTML = '<a target="_blank" href="' + url + '" style="color:black">' + h1.innerHTML + '</a>'
          const div = document.querySelector('div[class^=SongHeader__CoverArt]')
          div.innerHTML = '<a target="_blank" href="' + url + '">' + div.innerHTML + '</a>'
        }
        onload.push(clickableTitle037)

        // Show artwork
        onload.push(function showArtwork () {
          document.querySelectorAll('div[class^="SizedImage__Container"] noscript').forEach(function noScriptImage (noscript) {
            const div = noscript.parentNode
            div.innerHTML = noscript.innerHTML
            div.querySelector('img').style.left = '0px'
          })
        })
        onload.push(hideStuff)

        // Goto lyrics
        onload.push(function () {
          document.location.hash = '#lyrics'
        })

        // Make expandable content buttons work
        function expandContent () {
          const button = this
          const content = button.parentNode.querySelector('div[class*="__Content"]') || button.parentNode.parentNode.querySelector('div[class*="__Expandable"]')
          content.classList.forEach(function (className) {
            if (className.indexOf('__Content') === -1 && className.indexOf('__Expandable') === -1) {
              content.classList.remove(className)
            }
          })
          button.remove()
        }
        onload.push(function makeExpandablesWork () {
          document.querySelectorAll('div[class*="__Container"]').forEach(function (div) {
            const button = div.querySelector('button[class^="Button"]')
            if (button) {
              button.addEventListener('click', expandContent)
            }
          })
        })

        // Show annotations function
        function getAnnotationsContainer (a) {
          let c = document.getElementById('annotationcontainer958')
          if (!c) {
            c = document.body.appendChild(document.createElement('div'))
            c.setAttribute('id', 'annotationcontainer958')
            const isChrome = navigator.userAgent.indexOf('Chrome') !== -1
            document.head.appendChild(document.createElement('style')).innerHTML = `
            #annotationcontainer958 {
              opacity:0.0;
              display:none;
              transition:opacity 500ms;
              position:absolute;
              background:linear-gradient(to bottom, #FFF1, 5px, white);
              color:black;
              font: 100 1.125rem / 1.5 "Programme", sans-serif;
              max-width:95%;
              min-width:60%;
              margin:10px;
            }
            #annotationcontainer958 .arrow {
              height:30px;
            }
            #annotationcontainer958 .arrow:before {
              content: "";
              position: absolute;
              width: 0px;
              height: 0px;
              margin-top: 20px;
              ${isChrome ? 'margin-left: calc(50% - 15px);' : 'inset: -1rem 0px 0px 50%;'}
              border-style: solid;
              border-width: 0px 25px 20px;
              border-color: transparent transparent rgb(170, 170, 170);
            }
            #annotationcontainer958 .annotationcontent {
              background-color:#E9E9E9;
              padding:5px;
              border-bottom-left-radius: 5px;
              border-bottom-right-radius: 5px;
              border-top-right-radius: 0px;
              border-top-left-radius: 0px;
              box-shadow: #646464 5px 5px 5px;
            }
            #annotationcontainer958 .annotationtab {
              display:none
            }
            #annotationcontainer958 .annotationtab.selected {
              display:block
            }
            #annotationcontainer958 .annotationtabbar .tabbutton {
              background-color:#d0cece;
              cursor:pointer;
              user-select:none;
              padding: 1px 7px;
              margin: 0px 3px;
              border-radius: 5px 5px 0px 0px;
              box-shadow: #0000004f 2px -2px 3px;
              float:left
            }
            #annotationcontainer958 .annotationtabbar .tabbutton.selected {
              background-color:#E9E9E9;
            }
            #annotationcontainer958 .annotationcontent .annotationfooter {
              user-select: none;
            }
            #annotationcontainer958 .annotationcontent .annotationfooter > div {
              float: right;
              min-width: 20%;
              text-align: center;
            }
            #annotationcontainer958 .annotationcontent .redhint {
              color:#ff146470;
              padding:.1rem 0.7rem;
            }
          `
          }
          c.innerHTML = ''

          c.style.display = 'block'
          c.style.opacity = 1.0
          const rect = a.getBoundingClientRect()
          c.style.top = (window.scrollY + rect.top + rect.height + 3) + 'px'

          const arrow = c.querySelector('.arrow') || c.appendChild(document.createElement('div'))
          arrow.className = 'arrow'

          let annotationTabBar = c.querySelector('.annotationtabbar')
          if (!annotationTabBar) {
            annotationTabBar = c.appendChild(document.createElement('div'))
            annotationTabBar.classList.add('annotationtabbar')
          }
          annotationTabBar.innerHTML = ''
          annotationTabBar.style.display = 'block'

          let annotationContent = c.querySelector('.annotationcontent')
          if (!annotationContent) {
            annotationContent = c.appendChild(document.createElement('div'))
            annotationContent.classList.add('annotationcontent')
          }
          annotationContent.style.display = 'block'
          annotationContent.innerHTML = ''
          return [annotationTabBar, annotationContent]
        }
        function switchTab (ev) {
          const id = this.dataset.annotid
          document.querySelectorAll('#annotationcontainer958 .annotationtabbar .tabbutton').forEach((e) => e.classList.remove('selected'))
          document.querySelectorAll('#annotationcontainer958 .annotationtab').forEach((e) => e.classList.remove('selected'))
          this.classList.add('selected')
          document.querySelector(`#annotationcontainer958 .annotationtab[id="annottab_${id}"]`).classList.add('selected')
        }
        function showAnnotation4956 (ev) {
          ev.preventDefault()

          // Annotation id
          const m = this.href.match(/\/(\d+)\//)
          if (!m) {
            return
          }
          const id = m[1]

          // Highlight
          document.querySelectorAll('.annotated').forEach((e) => e.classList.remove('highlighted'))
          this.classList.add('highlighted')

          // Load all annotations
          if (typeof annotations1234 === 'undefined') {
            if (document.getElementById('annotationsdata1234')) {
              annotations1234 = JSON.parse(document.getElementById('annotationsdata1234').innerHTML)
            } else {
              annotations1234 = {}
              console.log('No annotation data found #annotationsdata1234')
            }
          }

          if (id in annotations1234) {
            const [annotationTabBar, annotationContent] = getAnnotationsContainer(this)
            annotations1234[id].forEach(function (annotation) {
            // Example for multiple annotations: https://genius.com/72796/
              const tabButton = annotationTabBar.appendChild(document.createElement('div'))
              tabButton.dataset.annotid = annotation.id
              tabButton.classList.add('tabbutton')
              tabButton.addEventListener('click', switchTab)
              if (annotation.state === 'verified') {
                tabButton.appendChild(document.createTextNode('Verified annotation'))
              } else {
                tabButton.appendChild(document.createTextNode('Genius annotation'))
              }

              let hint = ''
              if ('accepted_by' in annotation && !annotation.accepted_by) {
                hint = '<span class="redhint">⚠ This annotation is unreviewed</span><br>'
              }

              let header = '<div class="annotationheader" style="float:right">'
              let author = false
              if (annotation.authors.length === 1) {
                if (annotation.authors[0].name) {
                  author = decodeHTML(annotation.authors[0].name)
                  header += `<a href="${annotation.authors[0].url}">${author}</a>`
                } else {
                  author = decodeHTML(annotation.created_by.name)
                  header += `<a href="${annotation.created_by.url}">${author}</a>`
                }
              } else {
                header += `<span title="Created by ${annotation.created_by.name}">${annotation.authors.length} Contributors</span>`
              }
              header += '</div><br style="clear:right">'

              let footer = '<div class="annotationfooter">'
              footer += `<div title="Direct link to the annotation"><a href="${annotation.share_url}">🔗 Share</a></div>`
              if (annotation.pyongs_count) {
                footer += `<div title="Pyongs"> ⚡ ${annotation.pyongs_count}</div>`
              }
              if (annotation.comment_count) {
                footer += `<div title="Comments"> 💬 ${annotation.comment_count}</div>`
              }
              footer += '<div title="Total votes">'
              if (annotation.votes_total > 0) {
                footer += '+'
                footer += annotation.votes_total
                footer += '👍'
              } else if (annotation.votes_total < 0) {
                footer += '-'
                footer += annotation.votes_total
                footer += '👎'
              } else {
                footer += annotation.votes_total + '👍 👎'
              }
              footer += '</div>'
              footer += '<br style="clear:right"></div>'

              let body = ''
              if ('body' in annotation && annotation.body) {
                body = decodeHTML(annotation.body.html)
              }
              if ('being_created' in annotation && annotation.being_created) {
                if (author) {
                  body = author + ' is currently annotating this line.<br><br>' + body
                } else {
                  body = 'This line is currently being annotated.<br><br>' + body
                }
              }

              annotationContent.innerHTML += `
            <div class="annotationtab" id="annottab_${annotation.id}">
              ${hint}
              ${header}
              ${body}
              ${footer}
            </div>`
            })
            annotationTabBar.appendChild(document.createElement('br')).style.clear = 'left'
            if (annotations1234[id].length === 1) {
              annotationTabBar.style.display = 'none'
            }
            annotationTabBar.querySelector('.tabbutton').classList.add('selected')
            annotationContent.querySelector('.annotationtab').classList.add('selected')

            // Resize iframes and images in frame
            window.setTimeout(function () {
              const maxWidth = (document.body.clientWidth - 40) + 'px'
              annotationContent.querySelectorAll('iframe,img').forEach(function (e) {
                e.style.maxWidth = maxWidth
              })
              targetBlankLinks145() // Change link target to _blank
            }, 100)
          }
        }
        onload.push(function () {
          if (document.getElementById('annotationsdata1234')) {
            annotations1234 = JSON.parse(document.getElementById('annotationsdata1234').innerHTML)
          }
        })

        // Change links to target=_blank
        function targetBlankLinks145 () {
          const as = document.querySelectorAll('body a:not([href|="#"]):not([target=_blank])')
          as.forEach(function (a) {
            const href = a.getAttribute('href')
            if (!href) {
              return
            }
            if (!href.startsWith('#')) {
              a.target = '_blank'
              if (!href.startsWith('http')) {
                a.href = 'https://genius.com' + href
              } else if (href.startsWith(custom.domain)) {
                a.href = href.replace(custom.domain, 'https://genius.com')
              }
            }
          })
        }
        onload.push(() => window.setTimeout(targetBlankLinks145, 1000))

        if (!annotationsEnabled) {
        // Remove all annotations
          onload.push(function removeAnnotations135 () {
            document.querySelectorAll('div[class^="SongPage__Section"] a[class^="ReferentFragment"]').forEach(removeTagsKeepText)
          })
        } else {
        // Add click handler to annotations
          document.querySelectorAll('div[class^="SongPage__Section"] a[class^="ReferentFragment"]').forEach(function (a) {
            a.classList.add('annotated')
            a.addEventListener('click', showAnnotation4956)
          })
          document.body.addEventListener('click', function (e) {
          // Hide annotation container on click outside of it
            const annotationcontainer = document.getElementById('annotationcontainer958')
            if (annotationcontainer && !e.target.classList.contains('.annotated') && e.target.closest('.annotated') === null) {
              if (e.target.closest('#annotationcontainer958') === null) {
                annotationcontainer.style.display = 'none'
                annotationcontainer.style.opacity = 0.0
                document.querySelectorAll('.annotated').forEach((e) => e.classList.remove('highlighted'))
              }
            }
          })
        }

        // Adapt width
        onload.push(function () {
          const bodyWidth = document.body.getClientRects()[0].width
          document.querySelector('div[class^="Lyrics__Container"]').style.maxWidth = `calc(${bodyWidth}px - 1.5em)`
        })

        // Open real page if not in frame
        onload.push(function () {
          if (window.top === window) {
            document.location.href = document.querySelector('meta[property="og:url"]').content
          }
        })
        return onload
      },
      combine: function themeGeniusReactCombineGeniusResources (song, html, annotations, cb) {
        let headhtml = ''

        // Make annotations clickable
        const regex = /annotation-fragment="(\d+)"/g
        html = html.replace(regex, '$0 data-annotationid="$1"')

        // Change design
        html = html.split('<div class="leaderboard_ad_container">').join('<div class="leaderboard_ad_container" style="width:0px;height:0px">')

        // Remove cookie consent
        html = html.replace(/<script defer="true" src="https:\/\/cdn.cookielaw.org.+?"/, '<script ')

        // Add annotation data
        headhtml += '\n<script id="annotationsdata1234" type="application/json">' + JSON.stringify(annotations).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</script>'

        // Scrollbar colors
        headhtml += '\n<style>\nhtml{background-color:#181818;\nscrollbar-color:hsla(0,0%,100%,.3) transparent;\nscrollbar-width:auto;}\n</style>'

        // Highlight annotated lines on hover
        headhtml += `
      <style>
        .annotated span {
          background-color:#f0f0f0;
        }
        .annotated:hover span, .annotated.highlighted span {
          background-color:#ddd;
        }
      </style>`

        // Add to <head>
        const parts = html.split('</head>')
        html = parts[0] + '\n' + headhtml + '\n</head>' + parts.slice(1).join('</head>')
        return cb(html)
      }
    },

    cleanwhite: {
      name: 'Clean white',
      scripts: function themeCleanWhiteScripts () {
        const onload = []

        var annotations1234

        // Hide cookies box function
        // var iv45
        // function hideCookieBox458 () {if(document.querySelector(".optanon-allow-all")){document.querySelector(".optanon-allow-all").click(); clearInterval(iv458)}}
        // onload.push(function() { iv458 = window.setInterval(hideCookieBox458, 500) }

        // Hide footer
        function hideFooter895 () {
          const f = document.querySelectorAll('.footer div')
          if (f.length) {
            removeIfExists(f[0])
            removeIfExists(f[1])
          }
        }
        function hideSecondaryFooter895 () {
          if (document.querySelector('.footer.footer--secondary')) {
            document.querySelector('.footer.footer--secondary').parentNode.removeChild(document.querySelector('.footer.footer--secondary'))
          }
        }

        onload.push(hideFooter895)
        onload.push(hideSecondaryFooter895)

        // Hide other stuff
        function hideStuff235 () {
          const grayBox = document.querySelector('.column_layout-column_span-initial_content>.dfp_unit.u-x_large_bottom_margin.dfp_unit--in_read')
          removeIfExists(grayBox)
          removeIfExists(document.querySelector('.header .header-expand_nav_menu'))
        }
        onload.push(hideStuff235)

        // Show annotations function
        function showAnnotation1234 (ev) {
          ev.preventDefault()
          const id = this.dataset.annotationid
          document.querySelectorAll('.song_body-lyrics .referent--yellow.referent--highlighted').forEach(function (e) {
            e.className = e.className.replace(/\breferent--yellow\b/, '').replace(/\breferent--highlighted\b/, '')
          })
          this.className += ' referent--yellow referent--highlighted'
          if (typeof annotations1234 === 'undefined') {
            if (document.getElementById('annotationsdata1234')) {
              annotations1234 = JSON.parse(document.getElementById('annotationsdata1234').innerHTML)
            } else {
              annotations1234 = {}
              console.log('No annotation data found #annotationsdata1234')
            }
          }
          if (id in annotations1234) {
            const annotation = annotations1234[id][0]
            const main = document.querySelector('.annotationbox')
            main.innerHTML = ''
            main.style.display = 'block'
            const bodyRect = document.body.getBoundingClientRect()
            const elemRect = this.getBoundingClientRect()
            const top = elemRect.top - bodyRect.top + elemRect.height
            main.style.top = top + 'px'
            main.style.left = '5px'
            const div0 = document.createElement('div')
            div0.className = 'annotationcontent'
            main.appendChild(div0)
            let html = '<div class="annotationlabel">$author</div><div class="annotation_rich_text_formatting">$body</div>'
            html = html.replace(/\$body/g, decodeHTML(annotation.body.html)).replace(/\$author/g, decodeHTML(annotation.created_by.name))
            div0.innerHTML = html
            targetBlankLinks145() // Change link target to _blank
            window.setTimeout(function () { // hide on click
              document.body.addEventListener('click', hideAnnotationOnClick1234)
            }, 100)
            window.setTimeout(function () { // Resize iframes and images in frame
              const maxWidth = (document.body.clientWidth - 40) + 'px'
              main.querySelectorAll('iframe,img').forEach(function (e) {
                e.style.maxWidth = maxWidth
              })
            }, 100)
          }
        }
        function hideAnnotationOnClick1234 (ev) {
          let target = ev.target
          while (target) {
            if (target.id === 'annotationbox') {
              return
            }
            if (target.className && target.className.indexOf('referent') !== -1) {
              const id = parseInt(target.dataset.id)
              return showAnnotation1234.call(target, ev, id)
            }
            target = target.parentNode
          }
          document.body.removeEventListener('click', hideAnnotationOnClick1234)
          const main = document.querySelector('.annotationbox')
          main.style.display = 'none'
        }

        // Make song title clickable
        function clickableTitle037 () {
          if (!document.querySelector('.header_with_cover_art-primary_info-title')) {
            return
          }
          const url = document.querySelector('meta[property="og:url"]').content
          const h1 = document.querySelector('.header_with_cover_art-primary_info-title')
          h1.innerHTML = '<a target="_blank" href="' + url + '">' + h1.innerHTML + '</a>'
          // Featuring and album name
          const h2 = document.querySelector('.header_with_cover_art-primary_info-primary_artist').parentNode
          document.querySelectorAll('.metadata_unit-label').forEach(function (el) {
            if (el.innerText.toLowerCase().indexOf('feat') !== -1) {
              h1.innerHTML += ' ' + el.parentNode.innerText.trim()
            } else if (el.innerText.toLowerCase().indexOf('album') !== -1) {
              h2.innerHTML = h2.innerHTML + ' \u2022 ' + el.parentNode.querySelector('a').parentNode.innerHTML.trim()
            }
          })
          // Remove other meta like Producer
          while (document.querySelector('h3')) {
            document.querySelector('h3').remove()
          }
        }
        onload.push(clickableTitle037)

        // Change links to target=_blank
        function targetBlankLinks145 () {
          const as = document.querySelectorAll('body a:not([href|="#"]):not([target=_blank])')
          as.forEach(function (a) {
            a.target = '_blank'
          })
        }
        onload.push(() => window.setTimeout(targetBlankLinks145, 500))

        if (!annotationsEnabled) {
        // Remove all annotations
          onload.push(function removeAnnotations135 () {
            document.querySelectorAll('.song_body-lyrics .referent,.song_body-lyrics a[class*=referent]').forEach(function (a) {
              while (a.firstChild) {
                a.parentNode.insertBefore(a.firstChild, a)
              }
              a.remove()
            })
          })
        } else {
        // Add click handler to annotations
          document.querySelectorAll('*[data-annotationid]').forEach((a) => a.addEventListener('click', showAnnotation1234))
        }

        // Open real page if not in frame
        onload.push(function () {
          if (window.top === window) {
            document.location.href = document.querySelector('meta[property="og:url"]').content
          }
        })

        return onload
      },
      combine: function themeCleanWhiteXombineGeniusResources (song, html, annotations, onCombine) {
        let headhtml = ''
        const bodyWidth = document.getElementById('lyricsiframe').style.width || (document.getElementById('lyricsiframe').getClientRects()[0].width + 'px')

        if (html.indexOf('class="lyrics">') === -1) {
          const doc = new window.DOMParser().parseFromString(html, 'text/html')
          const originalUrl = doc.querySelector('meta[property="og:url"]').content

          if (html.indexOf('__PRELOADED_STATE__ = JSON.parse(\'') !== -1) {
            const jsonStr = html.split('__PRELOADED_STATE__ = JSON.parse(\'')[1].split('\');\n')[0].replace(/\\([^\\])/g, '$1').replace(/\\\\/g, '\\')
            const jData = JSON.parse(jsonStr)

            const root = parsePreloadedStateData(jData.songPage.lyricsData.body, document.createElement('div'))

            // Annotations
            root.querySelectorAll('a[data-id]').forEach(function (a) {
              a.dataset.annotationid = a.dataset.id
              a.classList.add('referent--yellow')
            })

            const lyricshtml = root.innerHTML

            const h1 = doc.querySelector('div[class^=SongHeader__Column] h1')
            const titleNode = h1.firstChild
            const titleA = h1.appendChild(document.createElement('a'))
            titleA.href = originalUrl
            titleA.target = '_blank'
            titleA.appendChild(titleNode)
            h1.classList.add('mytitle')

            const titlehtml = '<div class="myheader">' + h1.parentNode.outerHTML + '</div>'

            headhtml = `<style>
            body {
              background:#ffffff linear-gradient(to bottom, #fafafa, #ffffff) fixed;
              color:black;
              font-family:Roboto, Arial, sans-serif;
              max-width:${bodyWidth - 20}px;
              overflow-x:hidden;
            }
            .mylyrics {color: black; font-size: 1.3em; line-height: 1.3em;font-weight: 300; padding:0.1em;}
            .mylyrics a:link,.mylyrics a:visited,.mylyrics a:hover{color:black; padding:0; line-height: 1.3em; box-shadow: none;}
            .myheader {font-size: 1.0em; font-weight:300}
            .myheader a:link,.myheader a:visited {color: rgb(96, 96, 96);; font-size:1.0em; font-weight:300; text-decoration:none}
            h1.mytitle {font-size: 1.1em;}
            h1.mytitle a:link,h1.mytitle a:visited {color: rgb(96, 96, 96);; text-decoration:none}
            .referent--yellow.referent--highlighted { opacity:1.0; background-color: transparent; box-shadow: none; color:#1ed760; transition: color .2s linear;transition-property: color;transition-duration: 0.2s;transition-timing-function: linear;transition-delay: 0s;}
            .annotationbox {position:absolute; display:none; max-width:95%; min-width: 160px;padding: 3px 7px;margin: 2px 0 0;background-color: rgba(245, 245, 245, 0.98);background-clip: padding-box;border: 1px solid rgba(0,0,0,.15);border-radius: .25rem;}
            .annotationbox .annotationlabel {display:block;color:rgb(10, 10, 10);border-bottom:1px solid rgb(200,200,200);padding: 0;font-weight:600}
            .annotationbox .annotation_rich_text_formatting {color: black}
            .annotationbox .annotation_rich_text_formatting a {color: rgb(6, 95, 212)}
          </style>`

            // Add annotation data
            headhtml += '\n<script id="annotationsdata1234" type="application/json">' + JSON.stringify(annotations).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</script>'

            return onCombine(`
          <html>
          <head>
           ${headhtml}
          </head>
          <body>
            ${titlehtml}
            <div class="mylyrics song_body-lyrics">
            ${lyricshtml}
            </div>
            <div class="annotationbox" id="annotationbox"></div>
          </body>
          </html>
          `)
          }

          return onCombine(`<div style="color:black;background:white;font-family:sans-serif">
        <br>
        <h1>&#128561; Oops!</h1>
        <br>
        Sorry, these lyrics seem to use new genius page design.<br>They cannot be shown with the "Clean white theme" (yet)<br>
        Could you inform the author of this program about the problem and provide the following information:<br>
<pre style="color:black; background:silver; border:1px solid black; width:95%; overflow:auto;margin-left: 5px;padding: 0px 5px;">

Error:   Unknown genius page design
URL:     ${document.location.href}
Genius:  ${originalUrl}

</pre><br>
        You can simply post the information on github:<br>
        <a target="_blank" href="https://github.com/cvzi/GeniusLyricsUserscriptLibrary/issues/1">https://github.com/cvzi/GeniusLyricsUserscriptLibrary/issues/1</a>
        <br>
        or via email: <a target="_blank" href="mailto:cuzi@openmail.cc">cuzi@openmail.cc</a>
        <br>
        <br>
        Thanks for your help!
        <br>
        <br>
         </div>`)
        }

        // Make annotations clickable
        const regex = /annotation-fragment="(\d+)"/g
        html = html.replace(regex, '$0 data-annotationid="$1"')

        // Remove cookie consent
        html = html.replace(/<script defer="true" src="https:\/\/cdn.cookielaw.org.+?"/, '<script ')

        // Extract lyrics
        const lyrics = '<div class="mylyrics song_body-lyrics">' + html.split('class="lyrics">')[1].split('</div>')[0] + '</div>'

        // Extract title
        const title = '<div class="header_with_cover_art-primary_info">' + html.split('class="header_with_cover_art-primary_info">')[1].split('</div>').slice(0, 3).join('</div>') + '</div></div>'

        // Remove body content, hide horizontal scroll bar, add lyrics
        let parts = html.split('<body', 2)
        html = parts[0] + '<body' + parts[1].split('>')[0] + '>\n\n' +
      title + '\n\n' + lyrics +
      '\n\n<div class="annotationbox" id="annotationbox"></div><div style="height:5em"></div></body></html>'

        // Add annotation data
        headhtml += '\n<script id="annotationsdata1234" type="application/json">' + JSON.stringify(annotations).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</script>'

        // CSS
        headhtml += `<style>
          body {
            background:#ffffff linear-gradient(to bottom, #fafafa, #ffffff) fixed;
            color:black;
            font-family:Roboto, Arial, sans-serif;
            overflow-x:hidden;
            max-width:${bodyWidth}px;
          }
          .mylyrics {color: black; font-size: 1.3em; line-height: 1.1em;font-weight: 300; padding:0.1em;}
          .referent {background-color:inherit;box-shadow: none; line-height: 1.1em !important; }
          .windows a.referent {padding:0; line-height: 1.1em; background-color:inherit;box-shadow: none;}
          .windows a.referent:hover {background-color: rgb(230,230,230);border-radius: 2px;}
          .referent:hover {background-color: rgb(230,230,230);border-radius: 2px;}
          .windows a.referent:not(.referent--green):not(.referent--red):not(.referent--highlighted):not(.referent--image) { opacity:1.0; background-color: inherit; box-shadow: none; color:rgb(6, 95, 212); transition: color .2s linear;transition-property: color;transition-duration: 0.2s;transition-timing-function: linear;transition-delay: 0s;}
          .referent:not(.referent--green):not(.referent--red):not(.referent--highlighted):not(.referent--image) { opacity:1.0; background-color: inherit; box-shadow: none; color:#2c1cb7; transition: color .2s linear;transition-property: color;transition-duration: 0.2s;transition-timing-function: linear;transition-delay: 0s;}
          .windows a.referent:hover:not(.referent--green):not(.referent--red):not(.referent--highlighted):not(.referent--image) { background-color: rgb(230,230,230);border-radius: 2px;}
          .referent--yellow.referent--highlighted { opacity:1.0; background-color: inherit; box-shadow: none; color:#2c1cb7; transition: color .2s linear;transition-property: color;transition-duration: 0.2s;transition-timing-function: linear;transition-delay: 0s;}
          .annotationbox {position:absolute; display:none; max-width:95%; min-width: 160px;padding: 3px 7px;margin: 2px 0 0;background-color: rgba(245, 245, 245, 0.98);background-clip: padding-box;border: 1px solid rgba(0,0,0,.15);border-radius: .25rem;}
          .annotationbox .annotationlabel {display:block;color:rgb(10, 10, 10);border-bottom:1px solid rgb(200,200,200);padding: 0;font-weight:600}
          .annotationbox .annotation_rich_text_formatting {color: black}
          .annotationbox .annotation_rich_text_formatting a {color: rgb(6, 95, 212)}
          .header_with_cover_art-primary_info h1,.header_with_cover_art-primary_info h2,.header_with_cover_art-primary_info h3 {color: gray; font-size: 0.9em; line-height: 1.0em;font-weight: 300; }
          h1.header_with_cover_art-primary_info-title {line-height: 1.1em;}
          h1.header_with_cover_art-primary_info-title a {color: gray; font-size:1.1em}
          h2 a,h2 a.header_with_cover_art-primary_info-primary_artist {color: gray; font-size:1.0em; font-weight:300}
          .header_with_cover_art-primary_info {display:inline-block;color: black;border-radius: 2px;padding:7px 10px 0px 5px;}
        </style>`

        // Add to <head>
        parts = html.split('</head>')
        html = parts[0] + '\n' + headhtml + '\n</head>' + parts.slice(1).join('</head>')
        return onCombine(html)
      }
    },

    spotify: {
      name: 'Spotify',
      scripts: function themeSpotifyScripts () {
        const onload = []

        // Define globals
        var annotations1234

        // Hide cookies box function
        // var iv458
        // function hideCookieBox458 () {if(document.querySelector(".optanon-allow-all")){document.querySelector(".optanon-allow-all").click(); clearInterval(iv458)}}
        // onload.push(function() { iv458 = window.setInterval(hideCookieBox458, 500) })

        // Hide footer
        function hideFooter895 () { const f = document.querySelectorAll('.footer div'); if (f.length) { removeIfExists(f[0]); removeIfExists(f[1]) } }
        function hideSecondaryFooter895 () { if (document.querySelector('.footer.footer--secondary')) { document.querySelector('.footer.footer--secondary').parentNode.removeChild(document.querySelector('.footer.footer--secondary')) } }

        onload.push(hideFooter895)
        onload.push(hideSecondaryFooter895)

        // Hide other stuff
        function hideStuff235 () {
          const grayBox = document.querySelector('.column_layout-column_span-initial_content>.dfp_unit.u-x_large_bottom_margin.dfp_unit--in_read')
          removeIfExists(grayBox)
          removeIfExists(document.querySelector('.header .header-expand_nav_menu'))
        }
        onload.push(hideStuff235)

        // Show annotations function
        function showAnnotation1234 (ev) {
          ev.preventDefault()
          const id = this.dataset.annotationid
          document.querySelectorAll('.song_body-lyrics .referent--yellow.referent--highlighted').forEach(function (e) {
            e.className = e.className.replace(/\breferent--yellow\b/, '').replace(/\breferent--highlighted\b/, '')
          })
          this.className += ' referent--yellow referent--highlighted'
          if (typeof annotations1234 === 'undefined') {
            if (document.getElementById('annotationsdata1234')) {
              annotations1234 = JSON.parse(document.getElementById('annotationsdata1234').innerHTML)
            } else {
              annotations1234 = {}
              console.log('No annotation data found #annotationsdata1234')
            }
          }
          if (id in annotations1234) {
            const annotation = annotations1234[id][0]
            const main = document.querySelector('.annotationbox')
            main.innerHTML = ''
            main.style.display = 'block'
            const bodyRect = document.body.getBoundingClientRect()
            const elemRect = this.getBoundingClientRect()
            const top = elemRect.top - bodyRect.top + elemRect.height
            main.style.top = top + 'px'
            main.style.left = '5px'
            const div0 = document.createElement('div')
            div0.className = 'annotationcontent'
            main.appendChild(div0)
            let html = '<div class="annotationlabel">$author</div><div class="annotation_rich_text_formatting">$body</div>'
            html = html.replace(/\$body/g, decodeHTML(annotation.body.html)).replace(/\$author/g, decodeHTML(annotation.created_by.name))
            div0.innerHTML = html
            targetBlankLinks145() // Change link target to _blank
            window.setTimeout(function () { document.body.addEventListener('click', hideAnnotationOnClick1234) }, 100) // hide on click
          }
        }
        function hideAnnotationOnClick1234 (ev) {
          let target = ev.target
          while (target) {
            if (target.id === 'annotationbox') {
              return
            }
            if (target.className && target.className.indexOf('referent') !== -1) {
              const id = parseInt(target.dataset.id)
              return showAnnotation1234.call(target, ev, id)
            }
            target = target.parentNode
          }
          document.body.removeEventListener('click', hideAnnotationOnClick1234)
          const main = document.querySelector('.annotationbox')
          main.style.display = 'none'
        }

        onload.push(function () {
          if (document.getElementById('annotationsdata1234')) {
            annotations1234 = JSON.parse(document.getElementById('annotationsdata1234').innerHTML)
          }
        })

        // Make song title clickable
        function clickableTitle037 () {
          if (!document.querySelector('.header_with_cover_art-primary_info-title')) {
            return
          }
          const url = document.querySelector('meta[property="og:url"]').content
          const h1 = document.querySelector('.header_with_cover_art-primary_info-title')
          h1.innerHTML = '<a target="_blank" href="' + url + '">' + h1.innerHTML + '</a>'
          // Featuring and album name
          const h2 = document.querySelector('.header_with_cover_art-primary_info-primary_artist').parentNode
          document.querySelectorAll('.metadata_unit-label').forEach(function (el) {
            if (el.innerText.toLowerCase().indexOf('feat') !== -1) {
              h1.innerHTML += ' ' + el.parentNode.innerText.trim()
            } else if (el.innerText.toLowerCase().indexOf('album') !== -1) {
              h2.innerHTML = h2.innerHTML + ' \u2022 ' + el.parentNode.querySelector('a').parentNode.innerHTML.trim()
            }
          })
          // Remove other meta like Producer
          while (document.querySelector('h3')) {
            document.querySelector('h3').remove()
          }
        }
        onload.push(clickableTitle037)

        // Change links to target=_blank
        function targetBlankLinks145 () {
          const as = document.querySelectorAll('body a:not([href|="#"]):not([target=_blank])')
          as.forEach(function (a) {
            a.target = '_blank'
          })
        }
        onload.push(() => window.setTimeout(targetBlankLinks145, 1000))

        if (!annotationsEnabled) {
        // Remove all annotations
          onload.push(function removeAnnotations135 () {
            document.querySelectorAll('.song_body-lyrics .referent,.song_body-lyrics a[class*=referent]').forEach(function (a) {
              while (a.firstChild) {
                a.parentNode.insertBefore(a.firstChild, a)
              }
              a.remove()
            })
          })
        } else {
        // Add click handler to annotations
          document.querySelectorAll('*[data-annotationid]').forEach((a) => a.addEventListener('click', showAnnotation1234))
        }

        // Open real page if not in frame
        onload.push(function () {
          if (window.top === window) {
            document.location.href = document.querySelector('meta[property="og:url"]').content
          }
        })

        return onload
      },
      combine: function themeSpotifyXombineGeniusResources (song, html, annotations, onCombine) {
        let headhtml = ''
        const bodyWidth = document.getElementById('lyricsiframe').style.width || (document.getElementById('lyricsiframe').getClientRects()[0].width + 'px')

        if (html.indexOf('class="lyrics">') === -1) {
          const doc = new window.DOMParser().parseFromString(html, 'text/html')
          const originalUrl = doc.querySelector('meta[property="og:url"]').content

          if (html.indexOf('__PRELOADED_STATE__ = JSON.parse(\'') !== -1) {
            const jsonStr = html.split('__PRELOADED_STATE__ = JSON.parse(\'')[1].split('\');\n')[0].replace(/\\([^\\])/g, '$1').replace(/\\\\/g, '\\')
            const jData = JSON.parse(jsonStr)

            const root = parsePreloadedStateData(jData.songPage.lyricsData.body, document.createElement('div'))

            // Annotations
            root.querySelectorAll('a[data-id]').forEach(function (a) {
              a.dataset.annotationid = a.dataset.id
              a.classList.add('referent--yellow')
            })

            const lyricshtml = root.innerHTML

            const h1 = doc.querySelector('div[class^=SongHeader__Column] h1')
            const titleNode = h1.firstChild
            const titleA = h1.appendChild(document.createElement('a'))
            titleA.href = originalUrl
            titleA.target = '_blank'
            titleA.appendChild(titleNode)
            h1.classList.add('mytitle')

            const titlehtml = '<div class="myheader">' + h1.parentNode.outerHTML + '</div>'

            headhtml = `<style>
            @font-face{font-family:spotify-circular;src:url("https://open.scdn.co/fonts/CircularSpUIv3T-Light.woff2") format("woff2"),url(https://open.scdn.co/fonts/CircularSpUIv3T-Light.woff) format("woff"),url(https://open.scdn.co/fonts/CircularSpUIv3T-Light.ttf) format("truetype");font-weight:200;font-style:normal;font-display:swap}@font-face{font-family:spotify-circular;src:url("https://open.scdn.co/fonts/CircularSpUIv3T-Book.woff2") format("woff2"),url(https://open.scdn.co/fonts/CircularSpUIv3T-Book.woff) format("woff"),url(https://open.scdn.co/fonts/CircularSpUIv3T-Book.ttf) format("truetype");font-weight:400;font-style:normal;font-display:swap}@font-face{font-family:spotify-circular;src:url("https://open.scdn.co/fonts/CircularSpUIv3T-Bold.woff2") format("woff2"),url(https://open.scdn.co/fonts/CircularSpUIv3T-Bold.woff) format("woff"),url(https://open.scdn.co/fonts/CircularSpUIv3T-Bold.ttf) format("truetype");font-weight:600;font-style:normal;font-display:swap}@font-face{font-family:spotify-circular-arabic;src:url("https://open.scdn.co/fonts/CircularSpUIAraOnly-Light.woff2") format("woff2"),url(https://open.scdn.co/fonts/CircularSpUIAraOnly-Light.woff) format("woff"),url(https://open.scdn.co/fonts/CircularSpUIAraOnly-Light.otf) format("opentype");font-weight:200;font-style:normal;font-display:swap}@font-face{font-family:spotify-circular-arabic;src:url("https://open.scdn.co/fonts/CircularSpUIAraOnly-Book.woff2") format("woff2"),url(https://open.scdn.co/fonts/CircularSpUIAraOnly-Book.woff) format("woff"),url(https://open.scdn.co/fonts/CircularSpUIAraOnly-Book.otf) format("opentype");font-weight:400;font-style:normal;font-display:swap}@font-face{font-family:spotify-circular-arabic;src:url("https://open.scdn.co/fonts/CircularSpUIAraOnly-Bold.woff2") format("woff2"),url(https://open.scdn.co/fonts/CircularSpUIAraOnly-Bold.woff) format("woff"),url(https://open.scdn.co/fonts/CircularSpUIAraOnly-Bold.otf) format("opentype");font-weight:600;font-style:normal;font-display:swap}@font-face{font-family:spotify-circular-hebrew;src:url("https://open.scdn.co/fonts/CircularSpUIHbrOnly-Light.woff2") format("woff2"),url(https://open.scdn.co/fonts/CircularSpUIHbrOnly-Light.woff) format("woff"),url(https://open.scdn.co/fonts/CircularSpUIHbrOnly-Light.otf) format("opentype");font-weight:200;font-style:normal;font-display:swap}@font-face{font-family:spotify-circular-hebrew;src:url("https://open.scdn.co/fonts/CircularSpUIHbrOnly-Book.woff2") format("woff2"),url(https://open.scdn.co/fonts/CircularSpUIHbrOnly-Book.woff) format("woff"),url(https://open.scdn.co/fonts/CircularSpUIHbrOnly-Book.otf) format("opentype");font-weight:400;font-style:normal;font-display:swap}@font-face{font-family:spotify-circular-hebrew;src:url("https://open.scdn.co/fonts/CircularSpUIHbrOnly-Bold.woff2") format("woff2"),url(https://open.scdn.co/fonts/CircularSpUIHbrOnly-Bold.woff) format("woff"),url(https://open.scdn.co/fonts/CircularSpUIHbrOnly-Bold.otf) format("opentype");font-weight:600;font-style:normal;font-display:swap}@font-face{font-family:spotify-circular-cyrillic;src:url("https://open.scdn.co/fonts/CircularSpUICyrOnly-Light.woff2") format("woff2"),url(https://open.scdn.co/fonts/CircularSpUICyrOnly-Light.woff) format("woff"),url(https://open.scdn.co/fonts/CircularSpUICyrOnly-Light.otf) format("opentype");font-weight:200;font-style:normal;font-display:swap}@font-face{font-family:spotify-circular-cyrillic;src:url("https://open.scdn.co/fonts/CircularSpUICyrOnly-Book.woff2") format("woff2"),url(https://open.scdn.co/fonts/CircularSpUICyrOnly-Book.woff) format("woff"),url(https://open.scdn.co/fonts/CircularSpUICyrOnly-Book.otf) format("opentype");font-weight:400;font-style:normal;font-display:swap}@font-face{font-family:spotify-circular-cyrillic;src:url("https://open.scdn.co/fonts/CircularSpUICyrOnly-Bold.woff2") format("woff2"),url(https://open.scdn.co/fonts/CircularSpUICyrOnly-Bold.woff) format("woff"),url(https://open.scdn.co/fonts/CircularSpUICyrOnly-Bold.otf) format("opentype");font-weight:600;font-style:normal;font-display:swap}
            html{
              scrollbar-color:hsla(0,0%,100%,.3) transparent;
              scrollbar-width:auto; }
            body {
              background-color: rgba(0, 0, 0, 0);
              color:white;
              max-width: ${bodyWidth - 20}px;
              overflow-x:hidden;
              font-family:spotify-circular,spotify-circular-cyrillic,spotify-circular-arabic,spotify-circular-hebrew,Helvetica Neue,Helvetica,Arial,Hiragino Kaku Gothic Pro,Meiryo,MS Gothic,sans-serif;
            }
            .mylyrics {color: rgb(255,255,255,0.85); font-size: 1.3em; line-height: 1.1em;font-weight: 300; padding:0px 0.1em 0.1em 0.1em;}
            .mylyrics a:link,.mylyrics a:visited,.mylyrics a:hover{color:rgba(255,255,255,0.95)}
            .myheader {font-size: 1.0em; font-weight:300}
            .myheader a:link,.myheader a:visited {color: rgb(255,255,255,0.9); font-size:1.0em; font-weight:300; text-decoration:none}
            h1.mytitle {font-size: 1.1em;}
            h1.mytitle a:link,h1.mytitle a:visited {color: rgb(255,255,255,0.9); text-decoration:none}
            ::-webkit-scrollbar {width: 16px;}
            ::-webkit-scrollbar-thumb {background-color: hsla(0,0%,100%,.3);}
            .referent--yellow.referent--highlighted { opacity:1.0; background-color: transparent; box-shadow: none; color:#1ed760; transition: color .2s linear;transition-property: color;transition-duration: 0.2s;transition-timing-function: linear;transition-delay: 0s;}
            .annotationbox {position:absolute; display:none; max-width:95%; min-width: 160px;padding: 3px 7px;margin: 2px 0 0;background-color: #282828;background-clip: padding-box;border: 1px solid rgba(0,0,0,.15);border-radius: .25rem;}
            .annotationbox .annotationlabel {display:inline-block;background-color: hsla(0,0%,100%,.6);color: #000;border-radius: 2px;padding: 0 .3em;}
            .annotationbox .annotation_rich_text_formatting {color: rgb(255,255,255,0.6)}
            .annotationbox .annotation_rich_text_formatting a {color: rgb(255,255,255,0.9)}
          </style>`

            // Add annotation data
            headhtml += '\n<script id="annotationsdata1234" type="application/json">' + JSON.stringify(annotations).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</script>'

            return onCombine(`
          <html>
          <head>
           ${headhtml}
          </head>
          <body>
            ${titlehtml}
            <div class="mylyrics song_body-lyrics">
            ${lyricshtml}
            </div>
            <div class="annotationbox" id="annotationbox"></div>
          </body>
          </html>
          `)
          }

          return onCombine(`<div style="color:black;background:white;font-family:sans-serif">
        <br>
        <h1>&#128561; Oops!</h1>
        <br>
        Sorry, these lyrics seem to use new genius page design.<br>They cannot be shown with the "Spotify theme" (yet)<br>
        Could you inform the author of this program about the problem and provide the following information:<br>
<pre style="color:black; background:silver; border:1px solid black; width:95%; overflow:auto;margin-left: 5px;padding: 0px 5px;">

Error:   Unknown genius page design
Genius:  ${originalUrl}

</pre><br>
        You can simply post the information on github:<br>
        <a target="_blank" href="https://github.com/cvzi/Spotify-Genius-Lyrics-userscript/issues/4">https://github.com/cvzi/Spotify-Genius-Lyrics-userscript/issues/4</a>
        <br>
        or via email: <a target="_blank" href="mailto:cuzi@openmail.cc">cuzi@openmail.cc</a>
        <br>
        <br>
        Thanks for your help!
        <br>
        <br>
         </div>`)
        }

        // Make annotations clickable
        const regex = /annotation-fragment="(\d+)"/g
        html = html.replace(regex, '$0 data-annotationid="$1"')

        // Remove cookie consent
        html = html.replace(/<script defer="true" src="https:\/\/cdn.cookielaw.org.+?"/, '<script ')

        // Extract lyrics
        const lyrics = '<div class="mylyrics song_body-lyrics">' + html.split('class="lyrics">')[1].split('</div>')[0] + '</div>'

        // Extract title
        const title = '<div class="header_with_cover_art-primary_info">' + html.split('class="header_with_cover_art-primary_info">')[1].split('</div>').slice(0, 3).join('</div>') + '</div></div>'

        // Remove body content, hide horizontal scroll bar, add lyrics
        let parts = html.split('<body', 2)
        html = parts[0] + '<body style="overflow-x:hidden;width:100%;" ' + parts[1].split('>')[0] + '>\n\n' +
      title + '\n\n' + lyrics +
      '\n\n<div class="annotationbox" id="annotationbox"></div><div style="height:5em"></div></body></html>'

        // Add annotation data
        headhtml += '\n<script id="annotationsdata1234" type="application/json">' + JSON.stringify(annotations).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</script>'

        // CSS
        headhtml += `<style>
          @font-face{font-family:spotify-circular;src:url("https://open.scdn.co/fonts/CircularSpUIv3T-Light.woff2") format("woff2"),url(https://open.scdn.co/fonts/CircularSpUIv3T-Light.woff) format("woff"),url(https://open.scdn.co/fonts/CircularSpUIv3T-Light.ttf) format("truetype");font-weight:200;font-style:normal;font-display:swap}@font-face{font-family:spotify-circular;src:url("https://open.scdn.co/fonts/CircularSpUIv3T-Book.woff2") format("woff2"),url(https://open.scdn.co/fonts/CircularSpUIv3T-Book.woff) format("woff"),url(https://open.scdn.co/fonts/CircularSpUIv3T-Book.ttf) format("truetype");font-weight:400;font-style:normal;font-display:swap}@font-face{font-family:spotify-circular;src:url("https://open.scdn.co/fonts/CircularSpUIv3T-Bold.woff2") format("woff2"),url(https://open.scdn.co/fonts/CircularSpUIv3T-Bold.woff) format("woff"),url(https://open.scdn.co/fonts/CircularSpUIv3T-Bold.ttf) format("truetype");font-weight:600;font-style:normal;font-display:swap}@font-face{font-family:spotify-circular-arabic;src:url("https://open.scdn.co/fonts/CircularSpUIAraOnly-Light.woff2") format("woff2"),url(https://open.scdn.co/fonts/CircularSpUIAraOnly-Light.woff) format("woff"),url(https://open.scdn.co/fonts/CircularSpUIAraOnly-Light.otf) format("opentype");font-weight:200;font-style:normal;font-display:swap}@font-face{font-family:spotify-circular-arabic;src:url("https://open.scdn.co/fonts/CircularSpUIAraOnly-Book.woff2") format("woff2"),url(https://open.scdn.co/fonts/CircularSpUIAraOnly-Book.woff) format("woff"),url(https://open.scdn.co/fonts/CircularSpUIAraOnly-Book.otf) format("opentype");font-weight:400;font-style:normal;font-display:swap}@font-face{font-family:spotify-circular-arabic;src:url("https://open.scdn.co/fonts/CircularSpUIAraOnly-Bold.woff2") format("woff2"),url(https://open.scdn.co/fonts/CircularSpUIAraOnly-Bold.woff) format("woff"),url(https://open.scdn.co/fonts/CircularSpUIAraOnly-Bold.otf) format("opentype");font-weight:600;font-style:normal;font-display:swap}@font-face{font-family:spotify-circular-hebrew;src:url("https://open.scdn.co/fonts/CircularSpUIHbrOnly-Light.woff2") format("woff2"),url(https://open.scdn.co/fonts/CircularSpUIHbrOnly-Light.woff) format("woff"),url(https://open.scdn.co/fonts/CircularSpUIHbrOnly-Light.otf) format("opentype");font-weight:200;font-style:normal;font-display:swap}@font-face{font-family:spotify-circular-hebrew;src:url("https://open.scdn.co/fonts/CircularSpUIHbrOnly-Book.woff2") format("woff2"),url(https://open.scdn.co/fonts/CircularSpUIHbrOnly-Book.woff) format("woff"),url(https://open.scdn.co/fonts/CircularSpUIHbrOnly-Book.otf) format("opentype");font-weight:400;font-style:normal;font-display:swap}@font-face{font-family:spotify-circular-hebrew;src:url("https://open.scdn.co/fonts/CircularSpUIHbrOnly-Bold.woff2") format("woff2"),url(https://open.scdn.co/fonts/CircularSpUIHbrOnly-Bold.woff) format("woff"),url(https://open.scdn.co/fonts/CircularSpUIHbrOnly-Bold.otf) format("opentype");font-weight:600;font-style:normal;font-display:swap}@font-face{font-family:spotify-circular-cyrillic;src:url("https://open.scdn.co/fonts/CircularSpUICyrOnly-Light.woff2") format("woff2"),url(https://open.scdn.co/fonts/CircularSpUICyrOnly-Light.woff) format("woff"),url(https://open.scdn.co/fonts/CircularSpUICyrOnly-Light.otf) format("opentype");font-weight:200;font-style:normal;font-display:swap}@font-face{font-family:spotify-circular-cyrillic;src:url("https://open.scdn.co/fonts/CircularSpUICyrOnly-Book.woff2") format("woff2"),url(https://open.scdn.co/fonts/CircularSpUICyrOnly-Book.woff) format("woff"),url(https://open.scdn.co/fonts/CircularSpUICyrOnly-Book.otf) format("opentype");font-weight:400;font-style:normal;font-display:swap}@font-face{font-family:spotify-circular-cyrillic;src:url("https://open.scdn.co/fonts/CircularSpUICyrOnly-Bold.woff2") format("woff2"),url(https://open.scdn.co/fonts/CircularSpUICyrOnly-Bold.woff) format("woff"),url(https://open.scdn.co/fonts/CircularSpUICyrOnly-Bold.otf) format("opentype");font-weight:600;font-style:normal;font-display:swap}
          html{
            scrollbar-color:hsla(0,0%,100%,.3) transparent;
            scrollbar-width:auto; }
          body {
            background-color: rgba(0, 0, 0, 0);
            color:white;
            max-width:${bodyWidth - 20}px;
            overflow-x:hidden;
            font-family:spotify-circular,spotify-circular-cyrillic,spotify-circular-arabic,spotify-circular-hebrew,Helvetica Neue,Helvetica,Arial,Hiragino Kaku Gothic Pro,Meiryo,MS Gothic,sans-serif;
          }
          .mylyrics {color: rgb(255,255,255,0.6); font-size: 1.3em; line-height: 1.1em;font-weight: 300; padding:0.1em;}
          .referent {background-color:transparent;box-shadow: none;  line-height: 1.1em !important; }
          .windows a.referent {padding:0; line-height: 1.1em; background-color:transparent;box-shadow: none;}
          .windows a.referent:hover {background-color: hsla(0,0%,0%,.2);border-radius: 2px;}
          .referent:hover {background-color: hsla(0,0%,0%,.2);border-radius: 2px;}
          .windows a.referent:not(.referent--green):not(.referent--red):not(.referent--highlighted):not(.referent--image) { opacity:1.0; background-color: transparent; box-shadow: none; color:white; transition: color .2s linear;transition-property: color;transition-duration: 0.2s;transition-timing-function: linear;transition-delay: 0s;}
          .referent:not(.referent--green):not(.referent--red):not(.referent--highlighted):not(.referent--image) { opacity:1.0; background-color: transparent; box-shadow: none; color:white; transition: color .2s linear;transition-property: color;transition-duration: 0.2s;transition-timing-function: linear;transition-delay: 0s;}
          .windows a.referent:hover:not(.referent--green):not(.referent--red):not(.referent--highlighted):not(.referent--image) { background-color: hsla(0,0%,0%,.2);border-radius: 2px;}
          .referent--yellow.referent--highlighted { opacity:1.0; background-color: transparent; box-shadow: none; color:#1ed760; transition: color .2s linear;transition-property: color;transition-duration: 0.2s;transition-timing-function: linear;transition-delay: 0s;}
          .annotationbox {position:absolute; display:none; max-width:95%; min-width: 160px;padding: 3px 7px;margin: 2px 0 0;background-color: #282828;background-clip: padding-box;border: 1px solid rgba(0,0,0,.15);border-radius: .25rem;}
          .annotationbox .annotationlabel {display:inline-block;background-color: hsla(0,0%,100%,.6);color: #000;border-radius: 2px;padding: 0 .3em;}
          .annotationbox .annotation_rich_text_formatting {color: rgb(255,255,255,0.6)}
          .annotationbox .annotation_rich_text_formatting a {color: rgb(255,255,255,0.9)}
          .header_with_cover_art-primary_info h1,.header_with_cover_art-primary_info h2,.header_with_cover_art-primary_info h3 {color: rgb(255,255,255,0.5); font-size: 0.9em; line-height: 1.0em;font-weight: 300; }
          h1.header_with_cover_art-primary_info-title {line-height: 1.1em;}
          h1.header_with_cover_art-primary_info-title a {color: rgb(255,255,255,0.9); font-size:1.1em}
          h2 a,h2 a.header_with_cover_art-primary_info-primary_artist {color: rgb(255,255,255,0.9); font-size:1.0em; font-weight:300}
          .header_with_cover_art-primary_info {display:inline-block;background-color: hsla(0,0%,0%,.2);color: #000;border-radius: 2px;padding:7px 10px 0px 5px;}
          ::-webkit-scrollbar {width: 16px;}
          ::-webkit-scrollbar-thumb {background-color: hsla(0,0%,100%,.3);}
        </style>`

        // Add to <head>
        parts = html.split('</head>')
        html = parts[0] + '\n' + headhtml + '\n</head>' + parts.slice(1).join('</head>')
        return onCombine(html)
      }
    }
  }

  genius.option.themeKey = Object.keys(themes)[0]
  theme = themes[genius.option.themeKey]

  function combineGeniusResources (song, html, annotations, cb) {
    if (html.indexOf('__PRELOADED_STATE__ = JSON.parse') !== -1) {
      if (!genius.option.themeKey.endsWith('React') && (genius.option.themeKey + 'React') in themes) {
        genius.option.themeKey += 'React'
        theme = themes[genius.option.themeKey]
        console.log(`Temporarily activated React theme: ${theme.name}`)
      }
    } else {
      if (genius.option.themeKey.endsWith('React') && genius.option.themeKey.substring(0, genius.option.themeKey.length - 5) in themes) {
        genius.option.themeKey = genius.option.themeKey.substring(0, genius.option.themeKey.length - 5)
        theme = themes[genius.option.themeKey]
        console.log(`Temporarily deactivated React theme: ${theme.name}`)
      }
    }
    return theme.combine(song, html, annotations, cb)
  }

  function loadLyrics (force, beLessSpecific, songTitle, songArtistsArr, musicIsPlaying) {
    let songArtists = songArtistsArr.join(' ')
    if (force || (!document.hidden && musicIsPlaying && (genius.current.title !== songTitle || genius.current.artists !== songArtists))) {
      genius.current.title = songTitle
      genius.current.artists = songArtists

      const firstArtist = songArtistsArr[0]

      const simpleTitle = songTitle = songTitle.replace(/\s*-\s*.+?$/, '') // Remove anything following the last dash
      if (beLessSpecific) {
        songArtists = firstArtist
        songTitle = simpleTitle
      }
      const hitFromCache = getLyricsSelection(songTitle, songArtists)
      if (!force && hitFromCache) {
        showLyrics(hitFromCache, true)
      } else {
        geniusSearch(songTitle + ' ' + songArtists, function geniusSearchCb (r) {
          const hits = r.response.sections[0].hits
          if (hits.length === 0) {
            custom.hideLyrics()
            if (!beLessSpecific && (firstArtist !== songArtists || simpleTitle !== songTitle)) {
              // Try again with only the first artist or the simple title
              custom.addLyrics(!!force, true)
            } else if (force) {
              custom.showSearchField()
            } else {
              // No results
              if ('onNoResults' in custom) {
                custom.onNoResults(songTitle, songArtistsArr)
              }
            }
          } else if (hits.length === 1) {
            showLyrics(hits[0])
          } else {
            custom.listSongs(hits)
          }
        })
      }
    }
  }

  function showLyrics (song, searchresultsLengths) {
    const container = custom.getCleanLyricsContainer()

    if ('info' in custom.GM && 'scriptHandler' in custom.GM.info && custom.GM.info.scriptHandler === 'Greasemonkey') {
      container.innerHTML = '<h2>This script only works in <a target="_blank" href="https://addons.mozilla.org/en-US/firefox/addon/tampermonkey/">Tampermonkey</a></h2>Greasemonkey is no longer supported because of this <a target="_blank" href="https://github.com/greasemonkey/greasemonkey/issues/2574">bug greasemonkey/issues/2574</a> in Greasemonkey.'
      return
    }

    const separator = document.createElement('span')
    separator.setAttribute('class', 'second-line-separator')
    separator.setAttribute('style', 'padding:0px 3px')
    separator.appendChild(document.createTextNode('•'))

    const bar = document.createElement('div')
    bar.setAttribute('class', 'lyricsnavbar')
    bar.style.fontSize = '0.7em'
    bar.style.userSelect = 'none'
    container.appendChild(bar)

    // Resize button
    if ('initResize' in custom) {
      const resizeButton = document.createElement('span')
      resizeButton.style.fontSize = '1.8em'
      resizeButton.style.cursor = 'ew-resize'
      resizeButton.appendChild(document.createTextNode('⇹'))
      resizeButton.addEventListener('mousedown', custom.initResize)
      bar.appendChild(resizeButton)

      bar.appendChild(separator.cloneNode(true))
    }

    // Hide button
    const hideButton = document.createElement('a')
    hideButton.href = '#'
    hideButton.appendChild(document.createTextNode('Hide'))
    hideButton.addEventListener('click', function hideButtonClick (ev) {
      ev.preventDefault()
      genius.option.autoShow = false // Temporarily disable showing lyrics automatically on song change
      clearInterval(genius.iv.main)
      custom.hideLyrics()
    })
    bar.appendChild(hideButton)

    bar.appendChild(separator.cloneNode(true))

    // Config button
    const configButton = document.createElement('a')
    configButton.href = '#'
    configButton.appendChild(document.createTextNode('Options'))
    configButton.addEventListener('click', function configButtonClick (ev) {
      ev.preventDefault()
      config()
    })
    bar.appendChild(configButton)

    // Wrong lyrics
    if (searchresultsLengths === 0) {
      bar.appendChild(separator.cloneNode(true))

      const wrongLyricsButton = document.createElement('a')
      wrongLyricsButton.href = '#'
      wrongLyricsButton.appendChild(document.createTextNode('Wrong lyrics'))
      wrongLyricsButton.addEventListener('click', function wrongLyricsButtonClick (ev) {
        ev.preventDefault()
        document.querySelectorAll('.loadingspinnerholder').forEach((spinner) => spinner.remove())
        forgetLyricsSelection(genius.current.title, genius.current.artists, this.dataset.hit)
        custom.showSearchField(genius.current.artists + ' ' + genius.current.title)
      })
      bar.appendChild(wrongLyricsButton)
    }

    // Back button
    if (searchresultsLengths) {
      bar.appendChild(separator.cloneNode(true))

      const backbutton = document.createElement('a')
      backbutton.href = '#'
      if (searchresultsLengths === true) {
        backbutton.appendChild(document.createTextNode('Back to search results'))
      } else {
        backbutton.appendChild(document.createTextNode('Back to search (' + (searchresultsLengths - 1) + ' other result' + (searchresultsLengths === 2 ? '' : 's') + ')'))
      }
      backbutton.addEventListener('click', function backbuttonClick (ev) {
        ev.preventDefault()
        custom.showSearchField(genius.current.artists + ' ' + genius.current.title)
      })
      bar.appendChild(backbutton)
    }

    const iframe = document.createElement('iframe')
    iframe.id = 'lyricsiframe'
    container.appendChild(iframe)
    iframe.style.opacity = 0.1
    iframe.src = custom.emptyURL + '?405#html,' + encodeURIComponent('Loading...')

    custom.setFrameDimensions(container, iframe, bar)

    const spinnerHolder = document.body.appendChild(document.createElement('div'))
    spinnerHolder.classList.add('loadingspinnerholder')
    spinnerHolder.title = 'Downloading lyrics...'
    let spinner
    if ('createSpinner' in custom) {
      spinner = custom.createSpinner(spinnerHolder)
    } else {
      spinnerHolder.style.left = (iframe.getClientRects()[0].left + container.clientWidth / 2) + 'px'
      spinnerHolder.style.top = '100px'
      spinner = spinnerHolder.appendChild(document.createElement('div'))
      spinner.classList.add('loadingspinner')
    }
    spinner.innerHTML = '5'

    loadGeniusSong(song, function loadGeniusSongCb (html) {
      spinner.innerHTML = '4'
      spinnerHolder.title = 'Downloading annotations...'
      loadGeniusAnnotations(song, html, annotationsEnabled, function loadGeniusAnnotationsCb (song, html, annotations) {
        spinner.innerHTML = '3'
        spinnerHolder.title = 'Composing page...'
        combineGeniusResources(song, html, annotations, function combineGeniusResourcesCb (html) {
          spinner.innerHTML = '3'
          spinnerHolder.title = 'Loading page...'
          iframe.src = custom.emptyURL + '#html:post'
          const iv = window.setInterval(function () {
            spinner.innerHTML = '2'
            spinnerHolder.title = 'Rendering...'
            iframe.contentWindow.postMessage({ iAm: custom.scriptName, type: 'writehtml', html: html, themeKey: genius.option.themeKey }, '*')
          }, 1500)
          const clear = function () {
            if ('onLyricsReady' in custom) {
              custom.onLyricsReady(song, container)
            }
            window.clearInterval(iv)
            window.setTimeout(function () {
              iframe.style.opacity = 1.0
              spinnerHolder.remove()
            }, 1000)
          }
          addOneMessageListener('htmlwritten', function () {
            window.clearInterval(iv)
            spinner.innerHTML = '1'
            spinnerHolder.title = 'Calculating...'
          })
          addOneMessageListener('pageready', clear)
          window.setTimeout(clear, 30000)
        })
      })
    })
  }

  function searchByQuery (query, container) {
    geniusSearch(query, function geniusSearchCb (r) {
      const hits = r.response.sections[0].hits
      if (hits.length === 0) {
        window.alert(custom.scriptName + '\n\nNo search results')
      } else {
        custom.listSongs(hits, container, query)
      }
    })
  }

  function config () {
    loadCache()

    // Blur background
    document.querySelectorAll('body>*').forEach(function (e) {
      e.style.filter = 'blur(4px)'
    })
    if (document.getElementById('lyricscontainer')) {
      document.getElementById('lyricscontainer').style.filter = 'blur(1px)'
    }

    const win = document.body.appendChild(document.createElement('div'))
    win.setAttribute('id', 'myconfigwin39457845')

    const h1 = document.createElement('h1')
    win.appendChild(h1).appendChild(document.createTextNode('Options'))
    if ('scriptIssuesURL' in custom) {
      const a = document.createElement('a')
      a.href = custom.scriptIssuesURL
      win.appendChild(a).appendChild(document.createTextNode('scriptIssuesTitle' in custom ? custom.scriptIssuesTitle : custom.scriptIssuesURL))
    }

    // Switch: Show automatically
    let div = win.appendChild(document.createElement('div'))
    div.classList.add('divAutoShow')
    const checkAutoShow = div.appendChild(document.createElement('input'))
    checkAutoShow.type = 'checkbox'
    checkAutoShow.id = 'checkAutoShow748'
    checkAutoShow.checked = genius.option.autoShow === true
    custom.GM.getValue('optionautoshow', checkAutoShow.checked === true).then(function (v) {
    // Get real value, genius.option.autoShow might have been changed temporarily
      genius.option.autoShow = v === true || v === 'true'
      checkAutoShow.checked = genius.option.autoShow
    })
    const onAutoShow = function onAutoShowListener () {
      custom.GM.setValue('optionautoshow', checkAutoShow.checked === true)
      genius.option.autoShow = checkAutoShow.checked === true
    }
    checkAutoShow.addEventListener('click', onAutoShow)
    checkAutoShow.addEventListener('change', onAutoShow)

    let label = div.appendChild(document.createElement('label'))
    label.setAttribute('for', 'checkAutoShow748')
    label.appendChild(document.createTextNode(' Automatically show lyrics when new song starts'))

    div.appendChild(document.createElement('br'))
    div.appendChild(document.createTextNode('(if you disable this, a small button will appear in the top right corner to show the lyrics)'))

    // Select: Theme
    div = win.appendChild(document.createElement('div'))
    div.appendChild(document.createTextNode('Theme: '))
    const selectTheme = div.appendChild(document.createElement('select'))
    if (genius.option.themeKey.endsWith('React')) {
      genius.option.themeKey = genius.option.themeKey.substring(0, genius.option.themeKey.length - 5)
    }
    for (const key in themes) {
      if (key.endsWith('React')) {
        continue
      }
      const option = selectTheme.appendChild(document.createElement('option'))
      option.value = key
      if (genius.option.themeKey === key) {
        option.selected = true
      }
      option.appendChild(document.createTextNode(themes[key].name))
    }
    const onSelectTheme = function onSelectThemeListener () {
      const hasChanged = genius.option.themeKey !== selectTheme.selectedOptions[0].value
      if (hasChanged) {
        genius.option.themeKey = selectTheme.selectedOptions[0].value
        theme = themes[genius.option.themeKey]
        custom.GM.setValue('theme', genius.option.themeKey).then(() => custom.addLyrics(true))
      }
    }
    selectTheme.addEventListener('change', onSelectTheme)

    // Switch: Show annotations
    div = win.appendChild(document.createElement('div'))
    const checkAnnotationsEnabled = div.appendChild(document.createElement('input'))
    checkAnnotationsEnabled.type = 'checkbox'
    checkAnnotationsEnabled.id = 'checkAnnotationsEnabled748'
    checkAnnotationsEnabled.checked = annotationsEnabled === true
    const onAnnotationsEnabled = function onAnnotationsEnabledListener () {
      if (checkAnnotationsEnabled.checked !== annotationsEnabled) {
        annotationsEnabled = checkAnnotationsEnabled.checked === true
        custom.addLyrics(true)
        custom.GM.setValue('annotationsenabled', annotationsEnabled)
      }
    }
    checkAnnotationsEnabled.addEventListener('click', onAnnotationsEnabled)
    checkAnnotationsEnabled.addEventListener('change', onAnnotationsEnabled)

    label = div.appendChild(document.createElement('label'))
    label.setAttribute('for', 'checkAnnotationsEnabled748')
    label.appendChild(document.createTextNode(' Show annotations'))

    // Custom buttons
    if ('config' in custom) {
      custom.config.forEach(f => f(win.appendChild(document.createElement('div'))))
    }

    // Buttons
    div = win.appendChild(document.createElement('div'))

    const closeButton = div.appendChild(document.createElement('button'))
    closeButton.appendChild(document.createTextNode('Close'))
    closeButton.addEventListener('click', function onCloseButtonClick () {
      win.parentNode.removeChild(win)
      // Un-blur background
      document.querySelectorAll('body>*,#lyricscontainer').forEach(function (e) {
        e.style.filter = ''
      })
    })

    const bytes = metricPrefix(JSON.stringify(selectionCache).length + JSON.stringify(requestCache).length, 2, 1024) + 'Bytes'
    const clearCacheButton = div.appendChild(document.createElement('button'))
    clearCacheButton.appendChild(document.createTextNode('Clear cache (' + bytes + ')'))
    clearCacheButton.addEventListener('click', function onClearCacheButtonClick () {
      Promise.all([custom.GM.setValue('selectioncache', '{}'), custom.GM.setValue('requestcache', '{}')]).then(function () {
        clearCacheButton.innerHTML = 'Cleared'
        selectionCache = {}
        requestCache = {}
      })
    })
  }

  function addOneMessageListener (type, cb) {
    onMessage.push([type, cb])
  }

  function listenToMessages () {
    window.addEventListener('message', function (e) {
      if (!onMessage || typeof e.data !== 'object' || !('iAm' in e.data) || e.data.iAm !== custom.scriptName) {
        return
      }
      for (let i = 0; i < onMessage.length; i++) {
        if (onMessage[i][0] === e.data.type) {
          onMessage[i][1](e)
          onMessage.splice(i, 1)
          i--
        }
      }
    })
  }

  function addCss () {
    document.head.appendChild(document.createElement('style')).innerHTML = `
    #myconfigwin39457845 {
      position:absolute;
      top:120px;
      right:10px;
      padding:15px;
      background:white;
      border-radius:10%;
      border:2px solid black;
      color:black;
      z-index:103;
      font-size:1.2em
    }
    #myconfigwin39457845 h1 {
      font-size:1.9em;
      padding:0.2em;
    }
    #myconfigwin39457845 a:link, #myconfigwin39457845 a:visited {
      font-size:1.2em;
      text-decoration:underline;
      color:#7847ff;
      cursor:pointer;
    }
    #myconfigwin39457845 a:hover {
      font-size:1.2em;
      text-decoration:underline;
      color:#dd65ff;
    }
    #myconfigwin39457845 button {
      color:black;
      background:default;
    }
    #myconfigwin39457845 div {
      margin:2px 0;
      padding:5px;
      border-radius: 5px;
      background-color: #EFEFEF
    }
    .loadingspinner {
      color:rgb(255, 255, 100);
      text-align:center;
      pointer-events: none;
      width: 2.5em; height: 2.5em;
      border: 0.4em solid transparent;
      border-color: rgb(255, 255, 100) #181818 #181818 #181818;
      border-radius: 50%;
      animation: loadingspin 2s ease infinite
    }
    @keyframes loadingspin {
      25% {
        transform: rotate(90deg)
      }
      50% {
        transform: rotate(180deg)
      }
      75% {
        transform: rotate(270deg)
      }
      100% {
        transform: rotate(360deg)
      }
    }`

    if ('addCss' in custom) {
      custom.addCss()
    }
  }

  (function () {
    Promise.all([
      custom.GM.getValue('theme', genius.option.themeKey),
      custom.GM.getValue('annotationsenabled', annotationsEnabled)
    ]).then(function (values) {
      if (Object.prototype.hasOwnProperty.call(themes, values[0])) {
        genius.option.themeKey = values[0]
      } else {
        console.log('Invalid value for theme key: custom.GM.getValue("theme") = ' + values[0])
        genius.option.themeKey = Reflect.ownKeys(themes)[0]
      }
      theme = themes[genius.option.themeKey]
      annotationsEnabled = !!values[1]

      if (document.location.href.startsWith(custom.emptyURL + '#html:post')) {
        let received = false
        window.addEventListener('message', function (e) {
          if (received || typeof e.data !== 'object' || !('iAm' in e.data) || e.data.iAm !== custom.scriptName || e.data.type !== 'writehtml') {
            return
          }
          if ('themeKey' in e.data && Object.prototype.hasOwnProperty.call(themes, e.data.themeKey)) {
            genius.option.themeKey = e.data.themeKey
            theme = themes[genius.option.themeKey]
            console.log(`Theme activated in iframe: ${theme.name}`)
          }
          received = true
          document.write(e.data.html)
          e.source.postMessage({ iAm: custom.scriptName, type: 'htmlwritten' }, '*')
          window.setTimeout(function () {
            const onload = theme.scripts()
            onload.forEach(function (func) {
              try {
                func()
              } catch (e) {
                console.log(`Error in iframe onload ${func.name ? func.name : func}: ${e}`)
              }
            })
            e.source.postMessage({ iAm: custom.scriptName, type: 'pageready' }, '*')
          }, 500)
        })
      } else if (document.location.href.startsWith(custom.emptyURL + '?405#html,')) {
        document.write(decodeURIComponent(document.location.hash.split('#html,')[1]))
      } else {
        listenToMessages()
        loadCache()
        addCss()
        if ('main' in custom) {
          genius.iv.main = window.setInterval(custom.main, 2000)
        }
        if ('onResize' in custom) {
          window.addEventListener('resize', custom.onResize)
        }
      }
    })
  })()

  return genius
}
