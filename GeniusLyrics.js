// ==UserScript==
// @exclude      *
// ==UserLibrary==
// @name         GeniusLyrics
// @description  Downloads and shows genius lyrics for Tampermonkey scripts
// @version      5.5.0
// @license      GPL-3.0-or-later; http://www.gnu.org/licenses/gpl-3.0.txt
// @copyright    2020, cuzi (https://github.com/cvzi)
// @supportURL   https://github.com/cvzi/genius-lyrics-userscript/issues
// @icon         https://avatars.githubusercontent.com/u/2738430?s=200&v=4
// ==/UserLibrary==
// @homepageURL  https://github.com/cvzi/genius-lyrics-userscript
// ==/UserScript==

/*
    Copyright (C) 2019 cuzi (cuzi@openmail.cc)

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/*
    This library requires the following permission in the userscript:
      * grant GM.xmlHttpRequest
      * grant GM.getValue
      * grant GM.setValue
      * connect genius.com
*/

/* global Reflect, top */

if (typeof module !== 'undefined') {
  module.exports = geniusLyrics
}

function geniusLyrics (custom) { // eslint-disable-line no-unused-vars
  'use strict'

  if (typeof custom !== 'object') {
    if (typeof window !== 'undefined') window.alert('geniusLyrics requires options argument')
    throw new Error('geniusLyrics requires options argument')
  }

  Array.prototype.forEach.call([
    'GM',
    'scriptName',
    'domain',
    'emptyURL',
    'listSongs',
    'showSearchField',
    'addLyrics', // addLyrics would not immediately add lyrics panel
    'hideLyrics', // hideLyrics immediately hide lyrics panel
    'getCleanLyricsContainer',
    'setFrameDimensions'
  ], function (valName) {
    if (!(valName in custom)) {
      if (typeof window !== 'undefined') window.alert(`geniusLyrics requires parameter ${valName}`)
      throw new Error(`geniusLyrics() requires parameter ${valName}`)
    }
  })

  function hideLyricsWithMessage () {
    const ret = custom.hideLyrics(...arguments)
    if (ret === false) {
      return false
    }
    window.postMessage({ iAm: custom.scriptName, type: 'lyricsDisplayState', visibility: 'hidden' }, '*')
    return ret
  }

  const __SELECTION_CACHE_VERSION__ = 1
  const __REQUEST_CACHE_VERSION__ = 1
  const REQUEST_CACHE_RESPONSE_TEXT_ONLY = true

  const genius = {
    option: {
      autoShow: true,
      themeKey: null,
      cacheHTMLRequest: true
    },
    f: {
      metricPrefix,
      cleanUpSongTitle,
      showLyrics,
      showLyricsAndRemember,
      reloadCurrentLyrics,
      loadLyrics,
      hideLyricsWithMessage,
      rememberLyricsSelection,
      isGreasemonkey,
      forgetLyricsSelection,
      forgetCurrentLyricsSelection,
      getLyricsSelection,
      geniusSearch,
      searchByQuery,
      isScrollLyricsEnabled,
      scrollLyrics,
      config
    },
    current: {
      title: '',
      artists: ''
    },
    iv: {
      main: null
    },
    style: {
      enabled: false
    },
    styleProps: {
    },
    minimizeHit: {
      noImageURL: false,
      noFeaturedArtists: false,
      simpleReleaseDate: false,
      noRawReleaseDate: false,
      shortenArtistName: false,
      fixArtistName: false,
      removeStats: false, // note: true for YoutubeGeniusLyrics only
      noRelatedLinks: false
    },
    debug: false
  }

  function cleanRequestCache () {
    return {
      __VERSION__: __REQUEST_CACHE_VERSION__
    }
  }

  function cleanSelectionCache () {
    return {
      __VERSION__: __SELECTION_CACHE_VERSION__
    }
  }

  let loadingFailed = false
  let requestCache = cleanRequestCache()
  let selectionCache = cleanSelectionCache()
  let theme
  let annotationsEnabled = true
  let autoScrollEnabled = false
  const onMessage = {}

  function isFakeWindow () {
    // window is not window in Spotify Web App
    return (window instanceof window.constructor) === false
  }
  function getTrueWindow () {
    // this can bypass Spotify's window Proxy Object and obtain the original window object
    return new Function('return window')() // eslint-disable-line no-new-func
  }

  let trueWindow = isFakeWindow() ? getTrueWindow() : window
  const setTimeout = trueWindow.setTimeout.bind(trueWindow)
  const setInterval = trueWindow.setInterval.bind(trueWindow)
  const clearTimeout = trueWindow.clearTimeout.bind(trueWindow)
  const clearInterval = trueWindow.clearInterval.bind(trueWindow)
  trueWindow = null

  function getHostname (url) {
    // absolute path
    if (typeof url === 'string' && url.startsWith('http')) {
      const query = new URL(url)
      return query.hostname
    }
    // relative path - use <a> or new URL(url, document.baseURI)
    const a = document.createElement('a')
    a.href = url
    return a.hostname
  }

  function removeIfExists (e) {
    if (e && e.remove) {
      e.remove()
    }
  }
  const removeElements = (typeof window.DocumentFragment.prototype.append === 'function')
    ? function (elements) {
      document.createDocumentFragment().append(...elements)
    }
    : function (elements) {
      for (const element of elements) {
        element.remove()
      }
    }

  function removeTagsKeepText (node) {
    let tmpNode = null
    while ((tmpNode = node.firstChild) !== null) {
      if ('tagName' in tmpNode && tmpNode.tagName !== 'BR') {
        removeTagsKeepText(tmpNode)
      } else {
        node.parentNode.insertBefore(tmpNode, node)
      }
    }
    node.remove()
  }

  function decodeHTML (s) {
    return `${s}`.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
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

  function cleanUpSongTitle (songTitle) {
    // Remove featuring artists and version info from song title
    songTitle = songTitle.replace(/\((master|stereo|mono|anniversary|digital|edition|naked|original|re|ed|no.*?\d+|mix|version|\d+th|\d{4}|\s|\.|-|\/)+\)/i, '').trim()
    songTitle = songTitle.replace(/fe?a?t\.?u?r?i?n?g?\s+[^)]+/i, '')
    songTitle = songTitle.replace(/\(\s*\)/, ' ').replace('"', ' ').replace('[', ' ').replace(']', ' ').replace('|', ' ')
    songTitle = songTitle.replace(/\s\s+/, ' ')
    songTitle = songTitle.trim()
    return songTitle
  }

  function sumOffsets (obj) {
    const sums = { left: 0, top: 0 }
    while (obj) {
      sums.left += obj.offsetLeft
      sums.top += obj.offsetTop
      obj = obj.offsetParent
    }
    return sums
  }

  function parsePreloadedStateData (obj, parent) {
  // Convert genius' JSON represenation of lyrics to DOM object
    if ('children' in obj) {
      for (const child of obj.children) {
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
                value = `https://genius.com${value}`
              }
              node.setAttribute(attr, value)
            }
          }
          parsePreloadedStateData(child, node)
        }
      }
    }
    return parent
  }

  function convertSelectionCacheV0toV1 (selectionCache) {
    // the old cache key use '--' which is possible to mixed up with the brand name
    // the new cache key use '\t' as separator
    const ret = {}
    const bugKeys = []

    function pushBugKey (selectionCacheKey) {
      const s = selectionCacheKey.split(/\t/)
      if (s.length !== 2) return
      const songTitle = s[0]
      const artists = s[1]
      // setting simpleTitle as cache key was a bug
      const simpleTitle = songTitle.replace(/\s*-\s*.+?$/, '') // Remove anything following the last dash
      if (simpleTitle !== songTitle) {
        bugKeys.push(`${simpleTitle}\t${artists}`)
      }
    }

    console.warn('Genius Lyrics - old section cache is found: ', selectionCache)
    for (const originalKey in selectionCache) {
      if (originalKey === '__VERSION__') continue
      let k = 0
      const selectionCacheKey = originalKey
        .replace(/[\r\n\t\s]+/g, ' ')
        .replace(/--/g, () => {
          k++
          return '\t'
        })
      if (k === 1) {
        pushBugKey(selectionCacheKey)
        ret[selectionCacheKey] = selectionCache[originalKey]
      }
    }
    for (const bugKey of bugKeys) {
      delete ret[bugKey]
    }
    console.warn('Genius Lyrics - old section cache is converted to: ', ret)
    return ret
  }

  function loadRequestCache (storedValue) {
    // global requestCache
    if (storedValue === '{}') {
      requestCache = cleanRequestCache()
    } else {
      requestCache = JSON.parse(storedValue)
      if (!requestCache.__VERSION__) {
        requestCache.__VERSION__ = 0
      }
    }
    if (requestCache.__VERSION__ !== __REQUEST_CACHE_VERSION__) {
      requestCache = cleanRequestCache()
      custom.GM.setValue('requestcache', JSON.stringify(requestCache))
    }
  }

  function loadSelectionCache (storedValue) {
    // global selectionCache
    if (storedValue === '{}') {
      selectionCache = cleanSelectionCache()
    } else {
      selectionCache = JSON.parse(storedValue)
      if (!selectionCache.__VERSION__) {
        selectionCache.__VERSION__ = 0
      }
    }
    if (selectionCache.__VERSION__ !== __SELECTION_CACHE_VERSION__) {
      if (selectionCache.__VERSION__ === 0) {
        selectionCache = convertSelectionCacheV0toV1(selectionCache)
        selectionCache.__VERSION__ = __SELECTION_CACHE_VERSION__
      } else {
        selectionCache = cleanSelectionCache()
      }
      custom.GM.setValue('selectioncache', JSON.stringify(selectionCache))
    }
  }

  function loadCache () {
    Promise.all([
      custom.GM.getValue('selectioncache', '{}'),
      custom.GM.getValue('requestcache', '{}'),
      custom.GM.getValue('optionautoshow', true)
    ]).then(function (values) {
      loadSelectionCache(values[0])
      loadRequestCache(values[1])

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
        if (prop === '__VERSION__') continue
        // Delete cached values, that are older than 2 hours
        const time = requestCache[prop].split('\n')[0]
        if ((now - (new Date(time)).getTime()) > exp) {
          delete requestCache[prop]
        }
      }
    })
  }

  function invalidateRequestCache (obj) {
    const resultCachekey = JSON.stringify(obj)
    if (resultCachekey in requestCache) {
      delete requestCache[resultCachekey]
    }
  }

  function getRequestCacheKeyReplacer (key, value) {
    if (key === 'headers') {
      return undefined
    } else if (key === 'url') {
      if (typeof value !== 'string') return undefined
      let idx
      idx = value.lastIndexOf('/')
      value = `~${idx}${value.substring(idx)}`
      idx = value.indexOf('?')
      if (idx > 0) {
        value = value.substring(0, idx + 1) + decodeURIComponent(value.substring(idx + 1)).replace(/\s+/g, '-')
      }
    }
    return value
  }
  function getRequestCacheKey (obj) {
    return JSON.stringify(obj, getRequestCacheKeyReplacer)
  }

  function request (obj) {
    const cachekey = getRequestCacheKey(obj)
    if (cachekey in requestCache) {
      return obj.load(JSON.parse(requestCache[cachekey].split('\n')[1]), null)
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
      headers,
      onerror: obj.error ? obj.error : function xmlHttpRequestGenericOnError (response) { console.error('xmlHttpRequestGenericOnError: ' + response) },
      onload: function xmlHttpRequestOnLoad (response) {
        const time = (new Date()).toJSON()
        let cacheObject = null
        if (typeof obj.preProcess === 'function') {
          const proceed = obj.preProcess.call(this, response)
          if (typeof proceed === 'object') {
            cacheObject = proceed
          }
        }
        if (cacheObject === null) {
          // only if preProcess is undefined or preProcess() does not return a object
          if (REQUEST_CACHE_RESPONSE_TEXT_ONLY === true) {
            // only cache responseText
            cacheObject = { responseText: response.responseText }
          } else {
            // full object
            const newObject = Object.assign({}, response)
            newObject.responseText = response.responseText // key 'responseText' is not enumerable
            cacheObject = newObject
          }
        }
        // only cache when the callback call this function
        function cacheResult (cacheObject) {
          if (cacheObject !== null) {
            requestCache[cachekey] = time + '\n' + JSON.stringify(cacheObject)
            custom.GM.setValue('requestcache', JSON.stringify(requestCache))
          }
        }
        obj.load(cacheObject, cacheResult)
      }
    })
  }

  function getSelectionCacheKey (title, artists) {
    title = title.replace(/\s+/g, ' ') // space, \n, \t, ...
    artists = artists.replace(/\s+/g, ' ')
    const selectionCacheKey = `${title}\t${artists}`
    return selectionCacheKey
  }

  function rememberLyricsSelection (title, artists, jsonHit) {
    const selectionCacheKey = getSelectionCacheKey(title, artists)
    if (typeof jsonHit === 'object') {
      jsonHit = JSON.stringify(jsonHit)
    }
    if (typeof jsonHit !== 'string') {
      return
    }
    selectionCache[selectionCacheKey] = jsonHit
    custom.GM.setValue('selectioncache', JSON.stringify(selectionCache))
  }

  function forgetLyricsSelection (title, artists) {
    const selectionCacheKey = getSelectionCacheKey(title, artists)
    if (selectionCacheKey in selectionCache) {
      delete selectionCache[selectionCacheKey]
      custom.GM.setValue('selectioncache', JSON.stringify(selectionCache))
    }
  }

  function forgetCurrentLyricsSelection () {
    const title = genius.current.title
    const artists = genius.current.artists
    if (typeof title === 'string' && typeof artists === 'string') {
      forgetLyricsSelection(title, artists)
      return true
    }
    return false
  }

  function getLyricsSelection (title, artists) {
    const selectionCacheKey = getSelectionCacheKey(title, artists)
    if (selectionCacheKey in selectionCache) {
      return JSON.parse(selectionCache[selectionCacheKey])
    } else {
      return false
    }
  }

  function ReleaseDateComponent (components) {
    if (!components) return
    if (components.year - components.month - components.day > 0) { // avoid NaN
      return `${components.year}.${components.month < 10 ? '0' : ''}${components.month}.${components.day < 10 ? '0' : ''}${components.day}`
    }
    return null
  }

  function modifyHits (hits) {
    // the original hits store too much and not in a proper ordering
    // only song.result.url is neccessary

    // There are few instrumental music existing in Genius
    // No lyrics will be provided for instrumental music in Genius
    hits = hits.filter(hit => {
      if (hit.result.instrumental === true) return false
      if (hit.result.lyrics_state !== 'complete') return false
      return true
    })

    for (const hit of hits) {
      const result = hit.result
      if (!result) return
      const primaryArtist = result.primary_artist || 0
      const minimizeHit = genius.minimizeHit
      delete hit.highlights // always []
      delete result.annotation_count // always 0
      delete result.pyongs_count // always null
      if (minimizeHit.noImageURL) {
        // if the script does not require the images, remove to save storage
        delete result.header_image_thumbnail_url
        delete result.header_image_url
        delete result.song_art_image_thumbnail_url
        delete result.song_art_image_url
      }
      if (minimizeHit.noRelatedLinks) {
        delete result.relationships_index_url
      }

      if (minimizeHit.noFeaturedArtists) {
        // it can be a band of 35 peoples which is wasting storage
        delete result.featured_artists
      }
      if (primaryArtist) {
        if (minimizeHit.noImageURL) {
          delete primaryArtist.header_image_url
          delete primaryArtist.image_url
        }
        if (minimizeHit.noRelatedLinks) {
          delete primaryArtist.api_path
          delete primaryArtist.url
          delete primaryArtist.is_meme_verified
          delete primaryArtist.is_verified
          delete primaryArtist.index_character
          delete primaryArtist.slug
        }
      }

      // reduce release date storage
      if (minimizeHit.simpleReleaseDate && 'release_date_components' in result) {
        const c = ReleaseDateComponent(result.release_date_components)
        if (c !== null) {
          result.release_date = c
        }
      }
      if (minimizeHit.noRawReleaseDate) {
        delete result.release_date_components
        delete result.release_date_for_display
        delete result.release_date_with_abbreviated_month_for_display
      }

      if (minimizeHit.shortenArtistName && primaryArtist && typeof primaryArtist.name === 'string' && typeof result.artist_names === 'string') {
        // if it is a brand the title could be very long as it compose it with the full member names
        if (primaryArtist.name.length < result.artist_names.length) {
          result.artist_names = primaryArtist.name
        }
      }

      if (minimizeHit.fixArtistName) {
        if (result.language === 'romanization' && result.title === result.title_with_featured && result.artist_names === primaryArtist.name) {
          // Example: "なとり (Natori) - Overdose (Romanized)"
          const split = result.title.split(' - ')
          if (split.length === 2) {
            result.artist_names = split[0]
            primaryArtist.name = split[0]
            result.title = split[1]
            result.title_with_featured = split[1]
          }
        }
      }

      if (minimizeHit.removeStats) {
        delete result.stats
      }

      if (hits.length > 1) {
        if (hit.type === 'song') {
          hit._order = 2600
        } else {
          hit._order = 1300
        }
        if (hit.result.language === 'romanization') {
          hit._order -= 50
        }
        if (hit.result.updated_by_human_at) {
          hit._order += 400
        }
        if (hit.result.language === 'en') {
          // possible translation for non-english songs
          // if all results are en, no different for hit._order reduction
          hit._order -= 1000
        }
      }
    }

    if (hits.length > 1) {
      hits.sort((a, b) => {
        // if order is the same, compare the entry id (greater is more recent)
        return (b._order - a._order) || (b.result.id - a.result.id) || 0
      })
    }
    // console.log(hits)
    return hits
  }

  function geniusSearch (query, cb, cbError) {
    console.log('Genius Search Query', query)
    let requestObj = {
      url: 'https://genius.com/api/search/song?page=1&q=' + encodeURIComponent(query),
      headers: {
        'X-Requested-With': 'XMLHttpRequest'
      },
      t: 'search', // differentiate with other types of requesting
      error: function geniusSearchOnError (response) {
        window.alert(custom.scriptName + '\n\nError in geniusSearch(' + JSON.stringify(query) + ', ' + ('name' in cb ? cb.name : 'cb') + '):\n' + response)
        invalidateRequestCache(requestObj)
        if (typeof cbError === 'function') cbError()
        requestObj = null
      },
      preProcess: function geniusSearchPreProcess (response) {
        let jsonData = null
        let errorMsg = ''
        try {
          jsonData = JSON.parse(response.responseText)
        } catch (e) {
          errorMsg = e
        }
        if (jsonData !== null) {
          const section = (((jsonData || 0).response || 0).sections[0] || 0)
          const hits = section.hits || 0
          if (typeof hits !== 'object') {
            window.alert(custom.scriptName + '\n\n' + 'Incorrect Response Format' + ' in geniusSearch(' + JSON.stringify(query) + ', ' + ('name' in cb ? cb.name : 'cb') + '):\n\n' + response.responseText)
            invalidateRequestCache(requestObj)
            if (typeof cbError === 'function') cbError()
            requestObj = null
            return
          }
          section.hits = modifyHits(hits)
          return jsonData
        } else {
          window.alert(custom.scriptName + '\n\n' + (errorMsg || 'Error') + ' in geniusSearch(' + JSON.stringify(query) + ', ' + ('name' in cb ? cb.name : 'cb') + '):\n\n' + response.responseText)
          invalidateRequestCache(requestObj)
          if (typeof cbError === 'function') cbError()
          requestObj = null
        }
      },
      load: function geniusSearchOnLoad (jsonData, cacheResult) {
        if (typeof cacheResult === 'function') cacheResult(jsonData)
        cb(jsonData)
      }
    }
    request(requestObj)
  }

  function loadGeniusSong (song, cb) {
    request({
      url: song.result.url,
      theme: `${genius.option.themeKey}`, // different theme, differnt html cache
      error: function loadGeniusSongOnError (response) {
        window.alert(custom.scriptName + '\n\nError loadGeniusSong(' + JSON.stringify(song) + ', cb):\n' + response)
      },
      load: function loadGeniusSongOnLoad (response, cacheResult) {
        // cacheResult(response)
        cb(response, cacheResult)
      }
    })
  }

  async function delayScrolling (scrollLyricsGeneric) {
    let p1
    let p2 = document.scrollingElement.scrollTop
    do {
      p1 = p2
      await new Promise(r => window.requestAnimationFrame(r)) // eslint-disable-line promise/param-names
      p2 = document.scrollingElement.scrollTop
    } while (`${p1}` !== `${p2}`)
    // the scrollTop is stable now
    window.scrollLyricsBusy = false
    scrollLyricsGeneric(window.latestScrollPos, true)
  }

  function scrollLyricsFunction (lyricsContainerSelector, defaultStaticOffsetTop) {
    // Creates a scroll function for a specific theme
    return function scrollLyricsGeneric (position, force) {
      window.latestScrollPos = position

      if (window.scrollLyricsBusy) return
      window.scrollLyricsBusy = true

      const staticTop = 'staticOffsetTop' in window ? window.staticOffsetTop : defaultStaticOffsetTop

      const div = document.querySelector(lyricsContainerSelector)
      const offset = genius.debug ? sumOffsets(div) : null
      const offsetTop = (div.getBoundingClientRect().top - document.scrollingElement.getBoundingClientRect().top)
      // const containerHeight = document.documentElement.clientHeight

      const lastPos = window.lastScrollTopPosition
      let newScrollTop = staticTop + div.scrollHeight * position + offsetTop
      const maxScrollTop = document.scrollingElement.scrollHeight - document.scrollingElement.clientHeight
      const btns = document.querySelectorAll('#resumeAutoScrollButton, #resumeAutoScrollFromHereButton')

      if (newScrollTop > maxScrollTop) {
        newScrollTop = maxScrollTop
      } else if (newScrollTop < 0) {
        newScrollTop = 0
      }

      if (lastPos > 0 && Math.abs(lastPos - document.scrollingElement.scrollTop) > 5) {
        if (!force && document.visibilityState === 'visible') {
          // the scrolltop is updating by scrollTo({behavior:'smooth'})
          delayScrolling(scrollLyricsGeneric)
          return
        }
        window.staticOffsetTop = staticTop
        window.newScrollTopPosition = newScrollTop
        function setArrowUpDownStyle (arrowUpDown) {
          if (document.scrollingElement.scrollTop - window.newScrollTopPosition < 0) {
            arrowUpDown.style.borderBottom = ''
            arrowUpDown.style.borderTop = '18px solid #222'
            arrowUpDown.style.borderRight = '9px inset transparent'
            arrowUpDown.style.borderLeft = '9px inset transparent'
          } else {
            arrowUpDown.style.borderBottom = '18px solid #222'
            arrowUpDown.style.borderTop = ''
            arrowUpDown.style.borderRight = '9px inset transparent'
            arrowUpDown.style.borderLeft = '9px inset transparent'
          }
        }
        // User scrolled -> stop auto scroll
        if (!document.getElementById('resumeAutoScrollButton')) {
          const resumeButton = document.createElement('div')
          const resumeButtonFromHere = document.createElement('div')
          resumeButton.addEventListener('click', function resumeAutoScroll () {
            resumeButton.classList.remove('btn-show')
            resumeButtonFromHere.classList.remove('btn-show')
            window.lastScrollTopPosition = null
            // Resume auto scrolling
            document.scrollingElement.scrollTo({
              top: window.newScrollTopPosition,
              behavior: 'smooth'
            })
            window.scrollLyricsBusy = false
          })
          resumeButtonFromHere.addEventListener('click', function resumeAutoScrollFromHere () {
            resumeButton.classList.remove('btn-show')
            resumeButtonFromHere.classList.remove('btn-show')
            window.scrollLyricsBusy = false
            // Resume auto scrolling from current position
            if (genius.debug) {
              for (const e of document.querySelectorAll('.scrolllabel')) {
                e.remove()
              }
              window.first = false
            }
            window.lastScrollTopPosition = null
            window.staticOffsetTop += document.scrollingElement.scrollTop - window.newScrollTopPosition
          })
          resumeButton.id = 'resumeAutoScrollButton'
          resumeButton.setAttribute('title', 'Resume auto scrolling')
          const arrowUpDown = resumeButton.appendChild(document.createElement('div'))
          arrowUpDown.style = 'width: 0;height: 0;margin-left: 2px;'
          setArrowUpDownStyle(arrowUpDown)
          resumeButtonFromHere.id = 'resumeAutoScrollFromHereButton'
          resumeButtonFromHere.setAttribute('title', 'Resume auto scrolling from here')
          const arrowRight = resumeButtonFromHere.appendChild(document.createElement('div'))
          arrowRight.style = 'width: 0;height: 0;border-top: 9px inset transparent;border-bottom: 9px inset transparent;border-left: 15px solid #222;margin-left: 2px;'
          setTimeout(() => {
            if (newScrollTop > 0 && newScrollTop < maxScrollTop) {
              resumeButton.classList.add('btn-show')
              resumeButtonFromHere.classList.add('btn-show')
            }
            window.scrollLyricsBusy = false
          }, 40)
          appendElements(document.body, [resumeButton, resumeButtonFromHere])
        } else {
          const arrowUpDown = document.querySelector('#resumeAutoScrollButton div')
          setArrowUpDownStyle(arrowUpDown)
          window.scrollLyricsBusy = false
          setTimeout(() => {
            if (newScrollTop > 0 && newScrollTop < maxScrollTop) {
              btns[0].classList.add('btn-show')
              btns[1].classList.add('btn-show')
            }
            window.scrollLyricsBusy = false
          }, 40)
        }
        return
      }

      if (btns.length === 2) {
        btns[0].classList.remove('btn-show')
        btns[1].classList.remove('btn-show')
      }

      window.lastScrollTopPosition = newScrollTop
      document.scrollingElement.scrollTo({
        top: newScrollTop,
        behavior: 'smooth'
      })

      if (genius.debug) {
        if (!window.first) {
          window.first = true

          for (let i = 0; i < 11; i++) {
            const label = document.body.appendChild(document.createElement('div'))
            label.classList.add('scrolllabel')
            label.textContent = (`${i * 10}% + ${window.staticOffsetTop}px`)
            label.style.position = 'absolute'
            label.style.top = `${offset.top + window.staticOffsetTop + div.scrollHeight * 0.1 * i}px`
            label.style.color = 'rgba(255,0,0,0.5)'
            label.style.zIndex = 1000
          }

          let label = document.body.appendChild(document.createElement('div'))
          label.classList.add('scrolllabel')
          label.textContent = `Start @ offset.top +  window.staticOffsetTop = ${offset.top}px + ${window.staticOffsetTop}px`
          label.style.position = 'absolute'
          label.style.top = `${offset.top + window.staticOffsetTop}px`
          label.style.left = '200px'
          label.style.color = '#008000a6'
          label.style.zIndex = 1000

          label = document.body.appendChild(document.createElement('div'))
          label.classList.add('scrolllabel')
          label.textContent = `Base @ offset.top = ${offset.top}px`
          label.style.position = 'absolute'
          label.style.top = `${offset.top}px`
          label.style.left = '200px'
          label.style.color = '#008000a6'
          label.style.zIndex = 1000
        }

        let indicator = document.getElementById('scrollindicator')
        if (!indicator) {
          indicator = document.body.appendChild(document.createElement('div'))
          indicator.classList.add('scrolllabel')
          indicator.id = 'scrollindicator'
          indicator.style.position = 'absolute'
          indicator.style.left = '150px'
          indicator.style.color = '#00dbff'
          indicator.style.zIndex = 1000
        }
        indicator.style.top = `${offset.top + window.staticOffsetTop + div.scrollHeight * position}px`
        indicator.innerHTML = `${parseInt(position * 100)}%  -> ${parseInt(newScrollTop)}px`
      }
      window.scrollLyricsBusy = false
    }
  }

  function loadGeniusAnnotations (song, html, annotationsEnabled, cb) {
    let annotations = {}
    if (!annotationsEnabled) {
      // return cb(song, html, {})
      return cb(annotations)
    }
    let m = html.match(/annotation-fragment="\d+"/g)
    if (!m) {
      m = html.match(/href="\/\d+\//g)
      if (!m) {
        // No annotations in source -> skip loading annotations from API
        // return cb(song, html, {})
        return cb(annotations)
      }
    }

    const ids = m.map((s) => `ids[]=${s.match(/\d+/)[0]}`)

    const apiurl = 'https://genius.com/api/referents/multi?text_format=html%2Cplain&' + ids.join('&')

    request({
      url: apiurl,
      headers: {
        'X-Requested-With': 'XMLHttpRequest'
      },
      t: 'annotations', // differentiate with other types of requesting
      error: function loadGeniusAnnotationsOnError (response) {
        window.alert(custom.scriptName + '\n\nError loadGeniusAnnotations(' + JSON.stringify(song) + ', cb):\n' + response)
        cb(annotations)
      },
      preProcess: function loadGeniusAnnotationsPreProcess (response) {
        const r = JSON.parse(response.responseText).response
        annotations = {}
        if (typeof r.referents.length === 'number') {
          for (const referent of r.referents) {
            for (const annotation of referent.annotations) {
              if (annotation.referent_id in annotations) {
                annotations[annotation.referent_id].push(annotation)
              } else {
                annotations[annotation.referent_id] = [annotation]
              }
            }
          }
        } else {
          for (const refId in r.referents) {
            const referent = r.referents[refId]
            for (const annotation of referent.annotations) {
              if (annotation.referent_id in annotations) {
                annotations[annotation.referent_id].push(annotation)
              } else {
                annotations[annotation.referent_id] = [annotation]
              }
            }
          }
        }
        return annotations
      },
      load: function loadGeniusAnnotationsOnLoad (annotations, cacheResult) {
        if (typeof cacheResult === 'function') cacheResult(annotations)
        cb(annotations)
      }
    })
  }

  const themeCommon = {
    annotationsRemoveAll () {
      for (const a of document.querySelectorAll('.song_body-lyrics .referent,.song_body-lyrics a[class*="referent"]')) {
        let tmpElement
        while ((tmpElement = a.firstChild) !== null) {
          a.parentNode.insertBefore(tmpElement, a)
        }
        a.remove()
      }
    },
    annotationsRemoveAll2 () {
      const referents = document.querySelectorAll('.song_body-lyrics .referent')
      for (const a of referents) {
        let tmpElement
        while ((tmpElement = a.firstChild) !== null) {
          a.parentNode.insertBefore(tmpElement, a)
        }
        a.remove()
      }
      // Remove right column
      document.querySelector('.song_body.column_layout .column_layout-column_span--secondary').remove()
      document.querySelector('.song_body.column_layout .column_layout-column_span--primary').style.width = '100%'
    },
    // Hide footer
    hideFooter895 () {
      const f = document.querySelectorAll('.footer div')
      if (f.length) {
        removeIfExists(f[0])
        removeIfExists(f[1])
      }
    },
    hideSecondaryFooter895 () {
      removeIfExists(document.querySelector('.footer.footer--secondary'))
    },
    // Hide other stuff
    hideStuff235 () {
      const grayBox = document.querySelector('.column_layout-column_span-initial_content>.dfp_unit.u-x_large_bottom_margin.dfp_unit--in_read')
      removeIfExists(grayBox)
      removeIfExists(document.querySelector('.header .header-expand_nav_menu'))
    },
    showAnnotation1234A (t) {
      const es = document.querySelectorAll('.song_body-lyrics .referent--yellow.referent--highlighted')
      for (const e of es) {
        e.classList.remove('referent--yellow', 'referent--highlighted')
      }
      t.classList.add('referent--yellow', 'referent--highlighted')
      if (!('annotations1234' in window)) {
        if (document.getElementById('annotationsdata1234')) {
          window.annotations1234 = JSON.parse(document.getElementById('annotationsdata1234').innerHTML)
        } else {
          window.annotations1234 = {}
          console.warn('No annotation data found #annotationsdata1234')
        }
      }
    },
    // Change links to target=_blank
    targetBlankLinks145A () {
      const as = document.querySelectorAll('body a:not([href|="#"]):not([target="_blank"])')
      for (const a of as) {
        a.target = '_blank'
      }
    },
    targetBlankLinks145B () {
      const as = document.querySelectorAll('body a[href]:not([href|="#"]):not([target="_blank"])')
      for (const a of as) {
        const href = a.getAttribute('href')
        if (!href.startsWith('#')) {
          a.target = '_blank'
          if (!href.startsWith('http')) {
            a.href = 'https://genius.com' + href
          } else if (href.startsWith(custom.domain)) {
            a.href = href.replace(custom.domain, 'https://genius.com')
          }
        }
      }
    }
  }

  function appendHeadText (html, headhtml) {
    // Add to <head>
    const idxHead = html.indexOf('</head>')
    if (idxHead > 5) {
      html = html.substring(0, idxHead) + headhtml + html.substring(idxHead)
    } else {
      html = `<head>${headhtml}</head>${html}`
    }
    return html
  }

  const themes = {
    genius: {
      name: 'Genius (Default)', // obsoleted
      themeKey: 'genius',
      scripts: function themeGeniusScripts () {
        const onload = []

        function pushIfAny (arr, element) {
          if (element) {
            arr.push(element)
          }
        }

        function hideStuff () {
          let removals = []
          // Hide "Manage Lyrics" and "Click here to go to the old song page"
          pushIfAny(removals, document.querySelector('div[class^="LyricsControls_"]'))
          // Hide "This is a work in progress"
          pushIfAny(removals, document.getElementById('top'))
          // Header leaderboard/nav
          pushIfAny(removals, document.querySelector('div[class^="Leaderboard"]'))
          pushIfAny(removals, document.querySelector('div[class^="StickyNav"]'))
          // Footer except copyright hint
          let divs
          divs = document.querySelectorAll('div[class^="PageGriddesktop"] div[class^="PageFooterdesktop"]')
          for (const div of divs) {
            if (div.innerHTML.indexOf('©') === -1) {
              removals.push(div)
            }
          }
          divs = document.querySelectorAll('div[class^="PageGriddesktop"]')
          for (const div of divs) {
            div.className = ''
          }
          // Ads
          divs = document.querySelectorAll('div[class^="InreadAd__Container"],div[class^="InreadAddesktop__Container"]')
          for (const div of divs) {
            removals.push(div)
          }
          divs = document.querySelectorAll('div[class^="SidebarAd__Container"]')
          for (const div of divs) {
            removals.push(div.parentNode)
          }
          if (removals.length > 0) {
            removeElements(removals)
          }
          removals.length = 0
          removals = null
        }

        // Make song title clickable
        function clickableTitle037 () {
          const url = document.querySelector('meta[property="og:url"]').content
          const h1 = document.querySelector('h1[class^="SongHeader"]')
          h1.innerHTML = '<a target="_blank" href="' + url + '" style="color:black">' + h1.innerHTML + '</a>'
          const div = document.querySelector('div[class^=SongHeader][class*="__CoverArt"]')
          div.innerHTML = '<a target="_blank" href="' + url + '">' + div.innerHTML + '</a>'
        }
        onload.push(clickableTitle037)

        // Show artwork
        onload.push(function showArtwork () {
          const noscripts = document.querySelectorAll('div[class^="SizedImage__Container"] noscript')
          // noScriptImage
          for (const noscript of noscripts) {
            const div = noscript.parentNode
            div.innerHTML = noscript.innerHTML
            div.querySelector('img').style.left = '0px'
          }
        })
        onload.push(hideStuff)

        // Goto lyrics
        onload.push(function () {
          document.getElementById('lyrics').scrollIntoView()
        })

        // Make expandable content buttons work
        function expandContent () {
          const button = this
          const content = button.parentNode.querySelector('div[class*="__Content"]') || button.parentNode.parentNode.querySelector('div[class*="__Expandable"]')
          for (const className of content.classList) {
            if (className.indexOf('__Content') === -1 && className.indexOf('__Expandable') === -1) {
              content.classList.remove(className)
            }
          }
          button.remove()
        }
        onload.push(function makeExpandablesWork () {
          const divs = document.querySelectorAll('div[class*="__Container"]')
          for (const div of divs) {
            const button = div.querySelector('button[class^="Button"]')
            if (button) {
              button.addEventListener('click', expandContent)
            }
          }
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
          const selectedElements = document.querySelectorAll('#annotationcontainer958 .annotationtabbar .tabbutton.selected, #annotationcontainer958 .annotationtab.selected')
          for (const e of selectedElements) {
            e.classList.remove('selected')
          }
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
          const highlightedElements = document.querySelectorAll('.annotated.highlighted')
          for (const e of highlightedElements) {
            e.classList.remove('highlighted')
          }
          this.classList.add('highlighted')

          // Load all annotations
          if (!('annotations1234' in window)) {
            if (document.getElementById('annotationsdata1234')) {
              window.annotations1234 = JSON.parse(document.getElementById('annotationsdata1234').innerHTML)
            } else {
              window.annotations1234 = {}
              console.log('No annotation data found #annotationsdata1234')
            }
          }

          if (id in window.annotations1234) {
            const [annotationTabBar, annotationContent] = getAnnotationsContainer(this)
            let innerHTMLAddition = ''
            for (const annotation of window.annotations1234[id]) {
              // Example for multiple annotations: https://genius.com/72796/
              const tabButton = annotationTabBar.appendChild(document.createElement('div'))
              tabButton.dataset.annotid = annotation.id
              tabButton.classList.add('tabbutton')
              tabButton.addEventListener('click', switchTab)
              if (annotation.state === 'verified') {
                tabButton.textContent = ('Verified annotation')
              } else {
                tabButton.textContent = 'Genius annotation'
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

              innerHTMLAddition += `
              <div class="annotationtab" id="annottab_${annotation.id}">
                ${hint}
                ${header}
                ${body}
                ${footer}
              </div>`
            }
            annotationContent.innerHTML += innerHTMLAddition

            annotationTabBar.appendChild(document.createElement('br')).style.clear = 'left'
            if (window.annotations1234[id].length === 1) {
              annotationTabBar.style.display = 'none'
            }
            annotationTabBar.querySelector('.tabbutton').classList.add('selected')
            annotationContent.querySelector('.annotationtab').classList.add('selected')

            // Resize iframes and images in frame
            setTimeout(function () {
              const maxWidth = (document.body.clientWidth - 40) + 'px'
              const elements = annotationContent.querySelectorAll('iframe,img')
              for (const e of elements) {
                e.style.maxWidth = maxWidth
              }
              themeCommon.targetBlankLinks145B() // Change link target to _blank
            }, 100)
          }
        }
        onload.push(function () {
          if (document.getElementById('annotationsdata1234')) {
            window.annotations1234 = JSON.parse(document.getElementById('annotationsdata1234').innerHTML)
          }
        })

        onload.push(themeCommon.targetBlankLinks145B)
        onload.push(() => setTimeout(themeCommon.targetBlankLinks145B, 1000))

        if (!annotationsEnabled) {
          // Remove all annotations
          onload.push(function removeAnnotations135 () {
            document.querySelectorAll('div[class^="SongPage__Section"] a[class^="ReferentFragment"]').forEach(removeTagsKeepText)
          })
        } else {
          // Add click handler to annotations
          for (const a of document.querySelectorAll('div[class^="SongPage__Section"] a[class^="ReferentFragment"]')) {
            a.classList.add('annotated')
            a.addEventListener('click', showAnnotation4956)
          }
          document.body.addEventListener('click', function (e) {
          // Hide annotation container on click outside of it
            const annotationcontainer = document.getElementById('annotationcontainer958')
            if (annotationcontainer && !e.target.classList.contains('.annotated') && e.target.closest('.annotated') === null) {
              if (e.target.closest('#annotationcontainer958') === null) {
                annotationcontainer.style.display = 'none'
                annotationcontainer.style.opacity = 0.0
                for (const e of document.querySelectorAll('.annotated.highlighted')) {
                  e.classList.remove('highlighted')
                }
              }
            }
          })
        }

        // Adapt width
        onload.push(function () {
          const bodyWidth = document.body.getBoundingClientRect().width
          document.querySelector('div[class^="Lyrics__Container"]').style.maxWidth = `calc(${bodyWidth}px - 1.5em)`
          document.querySelector('#lyrics-root').style.gridTemplateColumns = 'auto' // class="SongPageGriddesktop__TwoColumn-
        })

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
        html = html.replace(/annotation-fragment="(\d+)"/g, '$0 data-annotationid="$1"')

        // Change design
        html = html.split('<div class="leaderboard_ad_container">').join('<div class="leaderboard_ad_container" style="width:0px;height:0px">')

        // Remove cookie consent
        html = html.replace(/<script defer="true" src="https:\/\/cdn.cookielaw.org.+?"/, '<script ')

        // Add base for relative hrefs
        headhtml += '\n<base href="https://genius.com/" target="_blank">'

        // Add annotation data
        headhtml += '\n<script id="annotationsdata1234" type="application/json">' + JSON.stringify(annotations).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</script>'

        // Scrollbar colors
        // Highlight annotated lines on hover
        headhtml += `
        <style>
          html{
            background-color: #181818;
            scrollbar-color: hsla(0,0%,100%,.3) transparent;
            scrollbar-width: auto;
          }
          .annotated span {
            background-color: #f0f0f0;
          }
          .annotated:hover span, .annotated.highlighted span {
            background-color: #ddd;
          }

          #resumeAutoScrollButton{
            position:fixed; right:65px; top:30%; cursor: pointer;border: 1px solid #d9d9d9;border-radius:100%;padding: 11px; z-index:101; background:white;
          }

          #resumeAutoScrollFromHereButton{
            position:fixed; right:20px; top:30%; cursor: pointer;border: 1px solid #d9d9d9;border-radius:100%;padding: 11px; z-index:101; background:white;
          }

          #resumeAutoScrollButton, #resumeAutoScrollFromHereButton{
            visibility: hidden;
            visibility: collapse;
          }
          #resumeAutoScrollButton.btn-show, #resumeAutoScrollFromHereButton.btn-show{
            visibility: visible;
          }
        </style>`

        // Add to <head>
        html = appendHeadText(html, headhtml)

        return cb(html)
      },
      // scrollLyrics: scrollLyricsFunction('div[class^="Lyrics__Container"]', -200)
      scrollLyrics: scrollLyricsFunction('div[class*="SongPage__LyricsWrapper"]', -120)
    },

    cleanwhite: {
      name: 'Clean white', // secondary theme
      themeKey: 'cleanwhite',
      scripts: function themeCleanWhiteScripts () {
        const onload = []

        // Hide cookies box function
        // var iv45
        // function hideCookieBox458 () {if(document.querySelector(".optanon-allow-all")){document.querySelector(".optanon-allow-all").click(); clearInterval(iv458)}}
        // onload.push(function() { iv458 = setInterval(hideCookieBox458, 500) }

        onload.push(themeCommon.hideFooter895)
        onload.push(themeCommon.hideSecondaryFooter895)
        onload.push(themeCommon.hideStuff235)

        // Show annotations function
        function showAnnotation1234 (ev) {
          ev.preventDefault()
          const id = this.dataset.annotationid
          themeCommon.showAnnotation1234A(this)
          if (id in window.annotations1234) {
            const annotation = window.annotations1234[id][0]
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
            themeCommon.targetBlankLinks145A() // Change link target to _blank
            setTimeout(function () { // hide on click
              document.body.addEventListener('click', hideAnnotationOnClick1234)
            }, 100)
            setTimeout(function () { // Resize iframes and images in frame
              const maxWidth = (document.body.clientWidth - 40) + 'px'
              const elements = main.querySelectorAll('iframe,img')
              for (const e of elements) {
                e.style.maxWidth = maxWidth
              }
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
          let s1 = ''
          let s2 = ''
          for (const el of document.querySelectorAll('.metadata_unit-label')) {
            if (el.innerText.toLowerCase().indexOf('feat') !== -1) {
              s1 += ' ' + el.parentNode.innerText.trim()
            } else if (el.innerText.toLowerCase().indexOf('album') !== -1) {
              s2 += ' \u2022 ' + el.parentNode.querySelector('a').parentNode.innerHTML.trim()
            }
          }
          h1.innerHTML += s1
          h2.innerHTML += s2
          // Remove other meta like Producer
          removeElements(document.querySelectorAll('h3'))
        }
        onload.push(clickableTitle037)

        onload.push(themeCommon.targetBlankLinks145A)
        onload.push(() => setTimeout(themeCommon.targetBlankLinks145A, 500))

        if (!annotationsEnabled) {
          // Remove all annotations
          onload.push(themeCommon.annotationsRemoveAll)
        } else {
          // Add click handler to annotations
          for (const a of document.querySelectorAll('*[data-annotationid]')) {
            a.addEventListener('click', showAnnotation1234)
          }
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
        const bodyWidth = document.getElementById('lyricsiframe').style.width || (document.getElementById('lyricsiframe').getBoundingClientRect().width + 'px')

        if (html.indexOf('class="lyrics">') === -1) {
          const doc = new window.DOMParser().parseFromString(html, 'text/html')
          const originalUrl = doc.querySelector('meta[property="og:url"]').content

          if (html.indexOf('__PRELOADED_STATE__ = JSON.parse(\'') !== -1) {
            const jsonStr = html.split('__PRELOADED_STATE__ = JSON.parse(\'')[1].split('\');\n')[0].replace(/\\([^\\])/g, '$1').replace(/\\\\/g, '\\')
            const jData = JSON.parse(jsonStr)

            const root = parsePreloadedStateData(jData.songPage.lyricsData.body, document.createElement('div'))

            // Annotations
            for (const a of root.querySelectorAll('a[data-id]')) {
              a.dataset.annotationid = a.dataset.id
              a.classList.add('referent--yellow')
            }

            const lyricshtml = root.innerHTML

            const h1 = doc.querySelector('div[class^=SongHeader][class*=Column] h1')
            const titleNode = h1.firstChild
            const titleA = h1.appendChild(document.createElement('a'))
            titleA.href = originalUrl
            titleA.target = '_blank'
            titleA.appendChild(titleNode)
            h1.classList.add('mytitle')

            removeIfExists(h1.parentNode.querySelector('div[class^="HeaderTracklist"]'))

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
        <a target="_blank" href="https://github.com/cvzi/genius-lyrics-userscript/issues/1">https://github.com/cvzi/genius-lyrics-userscript/issues/1</a>
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
        const parts = html.split('<body', 2)
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
        html = appendHeadText(html, headhtml)

        return onCombine(html)
      },
      scrollLyrics: scrollLyricsFunction('.mylyrics', -200)
    },

    spotify: {
      name: 'Spotify', // secondary theme
      themeKey: 'spotify',
      scripts: function themeSpotifyScripts () {
        const onload = []

        // Hide cookies box function
        // var iv458
        // function hideCookieBox458 () {if(document.querySelector(".optanon-allow-all")){document.querySelector(".optanon-allow-all").click(); clearInterval(iv458)}}
        // onload.push(function() { iv458 = setInterval(hideCookieBox458, 500) })

        onload.push(themeCommon.hideFooter895)
        onload.push(themeCommon.hideSecondaryFooter895)
        onload.push(themeCommon.hideStuff235)

        // Show annotations function
        function showAnnotation1234 (ev) {
          ev.preventDefault()
          const id = this.dataset.annotationid
          themeCommon.showAnnotation1234A(this)
          if (id in window.annotations1234) {
            const annotation = window.annotations1234[id][0]
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
            themeCommon.targetBlankLinks145A() // Change link target to _blank
            setTimeout(function () { document.body.addEventListener('click', hideAnnotationOnClick1234) }, 100) // hide on click
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
            window.annotations1234 = JSON.parse(document.getElementById('annotationsdata1234').innerHTML)
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
          let s1 = ''
          let s2 = ''
          for (const el of document.querySelectorAll('.metadata_unit-label')) {
            if (el.innerText.toLowerCase().indexOf('feat') !== -1) {
              s1 += ' ' + el.parentNode.innerText.trim()
            } else if (el.innerText.toLowerCase().indexOf('album') !== -1) {
              s2 += ' \u2022 ' + el.parentNode.querySelector('a').parentNode.innerHTML.trim()
            }
          }
          h1.innerHTML += s1
          h2.innerHTML += s2
          // Remove other meta like Producer
          removeElements(document.querySelectorAll('h3'))
        }
        onload.push(clickableTitle037)

        onload.push(() => setTimeout(themeCommon.targetBlankLinks145A, 1000))

        if (!annotationsEnabled) {
          // Remove all annotations
          onload.push(themeCommon.annotationsRemoveAll)
        } else {
          // Add click handler to annotations
          for (const a of document.querySelectorAll('*[data-annotationid]')) {
            a.addEventListener('click', showAnnotation1234)
          }
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
        const bodyWidth = document.getElementById('lyricsiframe').style.width || (document.getElementById('lyricsiframe').getBoundingClientRect().width + 'px')

        if (html.indexOf('class="lyrics">') === -1) {
          const doc = new window.DOMParser().parseFromString(html, 'text/html')
          const originalUrl = doc.querySelector('meta[property="og:url"]').content

          if (html.indexOf('__PRELOADED_STATE__ = JSON.parse(\'') !== -1) {
            const jsonStr = html.split('__PRELOADED_STATE__ = JSON.parse(\'')[1].split('\');\n')[0].replace(/\\([^\\])/g, '$1').replace(/\\\\/g, '\\')
            const jData = JSON.parse(jsonStr)

            const root = parsePreloadedStateData(jData.songPage.lyricsData.body, document.createElement('div'))

            // Annotations
            for (const a of root.querySelectorAll('a[data-id]')) {
              a.dataset.annotationid = a.dataset.id
              a.classList.add('referent--yellow')
            }

            const lyricshtml = root.innerHTML

            const h1 = doc.querySelector('div[class^=SongHeader][class*=Column] h1')
            const titleNode = h1.firstChild
            const titleA = h1.appendChild(document.createElement('a'))
            titleA.href = originalUrl
            titleA.target = '_blank'
            titleA.appendChild(titleNode)
            h1.classList.add('mytitle')

            removeIfExists(h1.parentNode.querySelector('div[class^="HeaderTracklist"]'))

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
        const parts = html.split('<body', 2)
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
        html = appendHeadText(html, headhtml)

        return onCombine(html)
      },
      scrollLyrics: scrollLyricsFunction('.mylyrics', -200)
    }
  }

  genius.option.themeKey = Object.keys(themes)[0]
  theme = themes[genius.option.themeKey]

  function combineGeniusResources (song, html, annotations, cb) {
    return theme.combine(song, html, annotations, cb)
  }

  function reloadCurrentLyrics () {
    // this is for special use - if the iframe is moved to another container, the content will be re-rendered.
    // As the lyrics is lost, it requires reloading
    const songTitle = genius.current.title
    const songArtists = genius.current.artists
    if (songTitle && songArtists) {
      const hitFromCache = getLyricsSelection(songTitle, songArtists)
      if (hitFromCache) {
        showLyrics(hitFromCache, 1)
        return true
      }
    }
    return false
  }

  function multipleResultsFound (hits, mTitle, mArtists) {
    // Multiple matches and no one exact match
    // or multiple artists multiple results
    if ('autoSelectLyrics' in custom) {
      const ret = custom.autoSelectLyrics(hits, mTitle, mArtists)
      if (ret && ret.hit) {
        showLyricsAndRemember(mTitle, mArtists, ret.hit, hits.length)
        return
      }
    }
    // let user decide
    custom.listSongs(hits)
  }

  function loadLyrics (force, beLessSpecific, songTitle, songArtistsArr, musicIsPlaying) {
    let songArtists = songArtistsArr.join(' ')
    if (force || beLessSpecific || (!document.hidden && musicIsPlaying && (genius.current.title !== songTitle || genius.current.artists !== songArtists))) {
      const mTitle = genius.current.title = songTitle
      const mArtists = genius.current.artists = songArtists

      const firstArtist = songArtistsArr[0]

      const simpleTitle = songTitle.replace(/\s*-\s*.+?$/, '') // Remove anything following the last dash
      if (beLessSpecific) {
        songArtists = firstArtist
        songTitle = simpleTitle
      }

      if ('onNewSongPlaying' in custom) {
        custom.onNewSongPlaying(songTitle, songArtistsArr)
      }

      const hitFromCache = getLyricsSelection(mTitle, mArtists)
      if (!force && hitFromCache) {
        showLyrics(hitFromCache, 1)
      } else {
        geniusSearch(songTitle + ' ' + songArtists, function geniusSearchCb (r) {
          const hits = r.response.sections[0].hits
          if (hits.length === 0) {
            hideLyricsWithMessage()
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
            // invalidate previous cache if any
            forgetLyricsSelection(mTitle, mArtists)
          } else if (hits.length === 1) {
            showLyricsAndRemember(mTitle, mArtists, hits[0], 1)
          } else if (songArtistsArr.length === 1) {
            // Check if one result is an exact match
            const exactMatches = []
            for (const hit of hits) {
              // hit sorted by _order
              if (hit.result.title.toLowerCase() === songTitle.toLowerCase() && hit.result.primary_artist.name.toLowerCase() === songArtistsArr[0].toLowerCase()) {
                exactMatches.push(hit)
              }
            }
            if (exactMatches.length === 1) {
              console.log(`Genius Lyrics - exact match is found in ${hits.length} results.`)
              showLyricsAndRemember(mTitle, mArtists, exactMatches[0], hits.length)
            } else {
              multipleResultsFound(hits, mTitle, mArtists)
            }
          } else {
            console.log('Genius Lyrics - lyrics results with multiple artists are found.')
            multipleResultsFound(hits, mTitle, mArtists)
          }
        }, function geniusSearchErrorCb () {
          // do nothing
        })
      }
    }
  }

  function appendElements (target, elements) {
    if (typeof target.append === 'function') {
      target.append(...elements)
    } else {
      for (const element of elements) {
        target.appendChild(element)
      }
    }
  }

  function isGreasemonkey () {
    return 'info' in custom.GM && 'scriptHandler' in custom.GM.info && custom.GM.info.scriptHandler === 'Greasemonkey'
  }

  function setupLyricsDisplayDOM (song, searchresultsLengths) {
    // getCleanLyricsContainer
    const container = custom.getCleanLyricsContainer()
    container.className = '' // custom.getCleanLyricsContainer might forget to clear the className if the element is reused
    container.classList.add('genius-lyrics-result-shown')

    if (isGreasemonkey()) {
      container.innerHTML = '<h2>This script only works in <a target="_blank" href="https://addons.mozilla.org/en-US/firefox/addon/tampermonkey/">Tampermonkey</a></h2>Greasemonkey is no longer supported because of this <a target="_blank" href="https://github.com/greasemonkey/greasemonkey/issues/2574">bug greasemonkey/issues/2574</a> in Greasemonkey.'
      return
    }

    let elementsToBeAppended = []

    let separator = document.createElement('span')
    separator.setAttribute('class', 'second-line-separator')
    separator.setAttribute('style', 'padding:0px 3px')
    separator.textContent = '•'

    const bar = document.createElement('div')
    bar.setAttribute('class', 'lyricsnavbar')
    bar.style.fontSize = '0.7em'
    bar.style.userSelect = 'none'

    // Resize button
    if ('initResize' in custom) {
      const resizeButton = document.createElement('span')
      resizeButton.style.fontSize = '1.8em'
      resizeButton.style.cursor = 'ew-resize'
      resizeButton.textContent = '⇹'
      resizeButton.addEventListener('mousedown', custom.initResize)
      elementsToBeAppended.push(resizeButton, separator.cloneNode(true))
    }

    // Hide button
    const hideButton = document.createElement('span')
    hideButton.classList.add('genius-lyrics-hide-button')
    hideButton.style.cursor = 'pointer'
    hideButton.textContent = 'Hide'
    hideButton.addEventListener('click', function hideButtonClick (ev) {
      genius.option.autoShow = false // Temporarily disable showing lyrics automatically on song change
      if (genius.iv.main > 0) {
        clearInterval(genius.iv.main)
        genius.iv.main = 0
      }
      hideLyricsWithMessage()
    })
    elementsToBeAppended.push(hideButton, separator.cloneNode(true))

    // Config button
    const configButton = document.createElement('span')
    configButton.classList.add('genius-lyrics-config-button')
    configButton.style.cursor = 'pointer'
    configButton.textContent = 'Options'
    configButton.addEventListener('click', function configButtonClick (ev) {
      config()
    })
    elementsToBeAppended.push(configButton)

    if (searchresultsLengths === 1) {
      // Wrong lyrics button
      const wrongLyricsButton = document.createElement('span')
      wrongLyricsButton.classList.add('genius-lyrics-wronglyrics-button')
      wrongLyricsButton.style.cursor = 'pointer'
      wrongLyricsButton.textContent = 'Wrong lyrics'
      wrongLyricsButton.addEventListener('click', function wrongLyricsButtonClick (ev) {
        removeElements(document.querySelectorAll('.loadingspinnerholder'))
        forgetLyricsSelection(genius.current.title, genius.current.artists)
        custom.showSearchField(`${genius.current.artists} ${genius.current.title}`)
      })
      elementsToBeAppended.push(separator.cloneNode(true), wrongLyricsButton)
    } else if (searchresultsLengths > 1) {
      // Back button
      const backbutton = document.createElement('span')
      backbutton.classList.add('genius-lyrics-back-button')
      backbutton.style.cursor = 'pointer'
      // searchresultsLengths === true is always false for searchresultsLengths > 1
      // if (searchresultsLengths === true) {
      //  backbutton.textContent = 'Back to search results'
      // } else {
      backbutton.textContent = `Back to search (${searchresultsLengths - 1} other result${searchresultsLengths === 2 ? '' : 's'})`
      // }
      backbutton.addEventListener('click', function backbuttonClick (ev) {
        custom.showSearchField(genius.current.artists + ' ' + genius.current.title)
      })
      elementsToBeAppended.push(separator.cloneNode(true), backbutton)
    }

    const iframe = document.createElement('iframe')
    iframe.id = 'lyricsiframe'
    iframe.style.opacity = 0.1

    // clean up
    separator = null

    // flush to DOM tree
    appendElements(bar, elementsToBeAppended)
    appendElements(container, [bar, iframe])

    // clean up
    elementsToBeAppended.length = 0
    elementsToBeAppended = null

    return {
      container,
      bar,
      iframe
    }
  }

  function contentStyling (html) {
    // only if genius.style.enable is set to true by external script
    if (genius.style.enabled !== true) return html
    if (typeof genius.style.setup === 'function') {
      if (genius.style.setup() === false) return html
    }

    const customProperties = Object.entries(genius.styleProps).map(([prop, value]) => {
      return `${prop}: ${value};`
    }).join('\n')

    const css = `
    html {
      margin: 0;
      padding: 0;
      ${customProperties}
    }

    body {
      background-color: var(--ygl-background);
      color: var(--ygl-color);
      font-size: var(--ygl-font-size);
      margin: 0;
      padding: 0;
      padding-top: 50vh;
      padding-bottom: 50vh;
    }

    main, #application {
      --ygl-container-display: none;
    }

    #application {
      padding: 28px;
    }

    div[data-lyrics-container]{
      font-size: var(--ygl-font-size);
    }

    div[class*="SongPageGrid"], div[class*="SongHeader"] {
      background-color: none;
      padding: 0;
      color: var(--ygl-color);
    }

    div[class*="SongPageGrid"], div[class*="SongHeaderWithPrimis__Container"]{
      background-image: none;
    }

    div[data-exclude-from-selection] {
      display: none;
    }

    main[class*="Container"] a[href] {
      color: var(--ygl-color) !important;
    }

    main[class*="Container"] h1[font-size][class] {
      color: var(--ygl-color);
    }

    div[class*="SongHeaderWithPrimis__Left"] {
      display: none;
    }

    div[class*="SongPageGriddesktop"] {
      display: block;
    }
    
    span[class*="LabelWithIcon"] > svg,
    button[class*="LabelWithIcon"] > svg,
    div[class*="Tooltip__Container"] svg{
      fill: currentColor;
    }

    p[class*="__Label"],
    span[class*="__Label"],
    div[class*="__Section"],
    button[class*="__Container"] {
      color: inherit;
      text-decoration: none;
      cursor: inherit;
    }

    div[class*="MetadataStats"] {
      cursor: default;
    }

    div[class*="SongHeaderWithPrimis__Information"] div[class*="HeaderCreditsPrimis__Container"] {
      display: flex;
      flex-direction: row;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
      justify-items: center;
    }

    div[class*="SongHeaderWithPrimis__Information"] {
      margin: 0;
      padding: 0;
      max-width: 100%;
      white-space: normal;
    }

    div[class*="SongHeaderWithPrimis__Bottom"] a[href] {
      padding: 0;
      margin: 0;
    }
    
    div[class*="SongHeaderWithPrimis__Right"]{
      background-color: var(--ygl-infobox-background);
      padding: 18px 26px;
    }

    div[data-lyrics-container][class*="Lyrics__Container"] {
      padding: 0;
    }

    body .annotated span,
    body .annotated span:hover,
    body a[href],
    body a[href]:hover,
    body .annotated a[href],
    body .annotated a[href]:hover,
    body a[href]:focus-visible,
    body .annotated a[href]:focus-visible,
    body .annotated:hover span,
    body .annotated.highlighted span {
      background-color: none;
      outline: none;
    }

    a[href][class],
    span[class*="PortalTooltip"],
    div[class*="HeaderCreditsPrimis"],
    div[class*="HeaderArtistAndTracklistPrimis"] {
      font-size: inherit;
    }
    
    div[class*="SongHeaderWithPrimis__Information"] h1 + div[class*="HeaderArtistAndTracklistPrimis"] {
      font-size: 80%;
      margin-top: 10px;
      margin-bottom: 6px;
    }

    div[class*="MetadataStats__Stats"] {  
      display: flex;
      flex-wrap: wrap;
      white-space: nowrap;    
      row-gap: 4px;
      column-gap: 16px;
      white-space: nowrap;
      margin-top: 6px;
    }

    h1,
    div[class*="SongPage__LyricsWrapper"] {
      white-space: normal;
    }
    
    div[class*="MetadataStats__Stats"] > [class] {
      margin-right: 0;
    }

    div[class*="SongHeaderWithPrimis__Information"] div[class*="HeaderCreditsPrimis__List"] {
      font-size: 85%;
    }

    div[class*="SongHeaderWithPrimis__Information"] ~ div[class*="SongHeaderWithPrimis__PrimisContainer"] {
      display: none;
    }

    div[class*="SongHeaderWithPrimis__Information"] {
      --ygl-container-display: '-NULL-';
    }

    div[class*="Footer"],
    div[class*="Leaderboard"] {
      display: none;
    }

    div[class*="SongPage__Section"] #about,
    div[class*="SongPage__Section"] #about ~ *,
    div[class*="SongPage__Section"] #comments,
    div[class*="SongPage__Section"] #comments ~ * {
      display: none;
    }
    
    div[class*="SongPage__Section"] #lyrics-root-pin-spacer {
      padding-top: 12px;
    }

    div[class*="Header"] {
      max-width: unset;
    }

    span[class*="InlineSvg__Wrapper"] > svg {
      fill: currentColor;
    }

    div[class*="SongHeader"] h1[font-size="medium"]{
      font-size: 140%;
    }
    `

    const headhtml = `<style>${css}</style>`

    // Add to <head>
    html = appendHeadText(html, headhtml)
    return html
  }

  let isShowLyricsInterrupted = false
  function interuptMessageHandler (ev) {
    const data = ev.data || 0
    if (data.iAm === custom.scriptName && data.type === 'lyricsDisplayState' && typeof data.visibility === 'string') {
      isShowLyricsInterrupted = data.visibility !== 'loading'
    }
  }

  function showLyrics (songInfo, searchresultsLengths) {
    // setup DOMs
    const { container, bar, iframe } = 'setupLyricsDisplayDOM' in custom
      ? custom.setupLyricsDisplayDOM(songInfo, searchresultsLengths)
      : setupLyricsDisplayDOM(songInfo, searchresultsLengths)

    if (!iframe || iframe.nodeType !== 1 || iframe.closest('html, body') === null) {
      console.warn('iframe#lyricsiframe is not inserted into the page.')
      return
    }

    iframe.src = custom.emptyURL + '#html:post'
    custom.setFrameDimensions(container, iframe, bar)
    if (typeof songInfo === 'object') {
      // do nothing; assume the object can be passed through postMessage
    } else {
      console.warn('The parameter \'songInfo\' in showLyrics() is incorrect.')
      return
    }
    if (typeof searchresultsLengths === 'number') {
      // do nothing
    } else {
      console.warn('The parameter \'searchresultsLengths\' in showLyrics() is incorrect.')
      return
    }

    const spinnerHolder = document.createElement('div')
    spinnerHolder.classList.add('loadingspinnerholder')
    let spinner
    if ('createSpinner' in custom) {
      spinner = custom.createSpinner(spinnerHolder)
    } else {
      spinnerHolder.style.left = (iframe.getBoundingClientRect().left + container.clientWidth / 2) + 'px'
      spinnerHolder.style.top = '100px'
      spinner = spinnerHolder.appendChild(document.createElement('div'))
      spinner.classList.add('loadingspinner')
    }
    document.body.appendChild(spinnerHolder)

    function spinnerUpdate (text, title, status, textStatus) {
      if (typeof text === 'string') spinner.textContent = text
      if (typeof title === 'string') spinnerHolder.title = title
      if ('notifyGeniusLoading' in custom && arguments.length > 2) {
        custom.notifyGeniusLoading({
          status,
          textStatus
        })
      }
    }

    window.removeEventListener('message', interuptMessageHandler, false)
    window.addEventListener('message', interuptMessageHandler, false)
    isShowLyricsInterrupted = false

    spinnerUpdate('5', 'Downloading lyrics...', 0, 'start')
    window.postMessage({ iAm: custom.scriptName, type: 'lyricsDisplayState', visibility: 'loading', song: songInfo, searchresultsLengths }, '*')

    function interuptedByExternal () {
      window.removeEventListener('message', interuptMessageHandler, false)
    }
    async function showLyricsRunner () {
      if (isShowLyricsInterrupted === true) return interuptedByExternal()
      let cacheReqResult = null
      let html = await new Promise(resolve => loadGeniusSong(songInfo, function loadGeniusSongCb (response, cacheResult) {
        cacheReqResult = cacheResult // cache the proceeded html only
        resolve(response.responseText)
      }))
      if (isShowLyricsInterrupted === true) return interuptedByExternal()

      if (cacheReqResult !== null) {
        // not obtained from cache
        spinnerUpdate('4', 'Downloading annotations...', 100, 'donwloading')
        let annotations = await new Promise(resolve => loadGeniusAnnotations(songInfo, html, annotationsEnabled, function loadGeniusAnnotationsCb (annotations) {
          resolve(annotations)
        }))
        if (isShowLyricsInterrupted === true) return interuptedByExternal()
        spinnerUpdate('3', 'Composing page...', 200, 'pageComposing')
        html = await new Promise(resolve => combineGeniusResources(songInfo, html, annotations, function combineGeniusResourcesCb (html) {
          // in fact `combineGeniusResources` is synchronous
          resolve(html)
        }))
        if (isShowLyricsInterrupted === true) return interuptedByExternal()
        annotations = null
        html = contentStyling(html)
        if (genius.option.cacheHTMLRequest === true) cacheReqResult({ responseText: html }) // note: 1 page consume 2XX KBytes
      }

      spinnerUpdate('3', 'Loading page...', 300, 'pageLoading')

      // obtain the iframe detailed information
      let tv1 = 0
      let tv2 = 0
      let iv = 0
      const clear = function () {
        // a. clear() when LyricsReady (success)
        // b. clear() when failed (after 30s)
        window.removeEventListener('message', interuptMessageHandler, false)
        if ('onLyricsReady' in custom) {
          // only on success ???
          custom.onLyricsReady(songInfo, container)
        }
        if (iv > 0) {
          clearInterval(iv)
          iv = 0
        }
        clearTimeout(tv1)
        clearTimeout(tv2)
        iframe.style.opacity = 1.0
        spinnerHolder.remove()
      }

      // event listeners
      addOneMessageListener('genius-iframe-waiting', function () {
        if (iv === 0) {
          return
        }
        ivf() // this is much faster than 1500ms
        clearInterval(iv)
        iv = 0
      })
      addOneMessageListener('htmlwritten', function () {
        if (iv > 0) {
          clearInterval(iv)
          iv = 0
        }
        spinnerUpdate('1', 'Calculating...', 302, 'htmlwritten')
      })
      addOneMessageListener('pageready', function (ev) {
        // note: this is not called after the whole page is rendered
        // console.log(ev.data)
        clear() // loaded
        spinnerUpdate(null, null, 901, 'complete')
        window.postMessage({ iAm: custom.scriptName, type: 'lyricsDisplayState', visibility: 'loaded', lyricsSuccess: true }, '*')
      })

      function reloadFrame () {
        // no use if the iframe is detached
        tv1 = 0
        console.debug('tv1')
        iframe.src = 'data:text/html,%3Ch1%3ELoading...%21%3C%2Fh1%3E'
        setTimeout(function () {
          iframe.src = custom.emptyURL + '#html:post'
        }, 400)
      }
      // After 15 seconds, try to reload the iframe
      tv1 = setTimeout(reloadFrame, 15000)

      function fresh () {
        tv2 = 0
        console.debug('tv2')
        clear() // unable to load
        spinnerUpdate(null, null, 902, 'failed')
        window.postMessage({ iAm: custom.scriptName, type: 'lyricsDisplayState', visibility: 'loaded', lyricsSuccess: false }, '*')
        if (!loadingFailed) {
          console.debug('try again fresh')
          loadingFailed = true
          hideLyricsWithMessage()
          setTimeout(function () {
            custom.addLyrics(true)
          }, 100)
        }
      }
      // After 30 seconds, try again fresh (only once)
      tv2 = setTimeout(fresh, 30000)

      function unableToProcess (msg) {
        clearInterval(iv)
        iv = 0
        console.warn(msg)
        clearTimeout(tv1)
        clearTimeout(tv2)
        // iframe is probrably detached from the page
        if (tv2 > 0) {
          fresh()
        }
      }

      const ivf = () => {
        if (iv === 0) {
          return
        }
        if (isShowLyricsInterrupted === true) {
          // this is possible if the lyrics was hidden by other function calling
          unableToProcess('Genius Lyrics - showLyrics() was interrupted')
        }
        spinnerUpdate('2', 'Rendering...', 301, 'pageRendering')
        if (iframe.contentWindow && iframe.contentWindow.postMessage) {
          iframe.contentWindow.postMessage({ iAm: custom.scriptName, type: 'writehtml', html, themeKey: genius.option.themeKey }, '*')
        } else if (iframe.closest('html, body') === null) {
          // unlikely as interupter_lyricsDisplayState is checked
          unableToProcess('iframe#lyricsiframe was removed from the page. No contentWindow could be found.')
        } else {
          // console.debug('iframe.contentWindow is ', iframe.contentWindow)
        }
      }
      iv = setInterval(ivf, 1500)
    }
    showLyricsRunner()
  }

  function showLyricsAndRemember (title, artists, hit, searchresultsLengths) {
    showLyrics(hit, searchresultsLengths)
    // store the selection
    Promise.resolve(0).then(() => {
      return JSON.stringify(hit)
    }).then(jsonHit => {
      rememberLyricsSelection(title, artists, jsonHit)
    })
  }

  function isScrollLyricsEnabled () {
    return autoScrollEnabled && ('scrollLyrics' in theme)
  }

  function scrollLyrics (positionFraction) {
    if (isScrollLyricsEnabled() === false) {
      return
    }
    // Relay the event to the iframe
    const iframe = document.getElementById('lyricsiframe')
    const contentWindow = (iframe || 0).contentWindow
    if (contentWindow && typeof contentWindow.postMessage === 'function') {
      contentWindow.postMessage({ iAm: custom.scriptName, type: 'scrollLyrics', position: positionFraction }, '*')
    }
  }

  function searchByQuery (query, container) {
    geniusSearch(query, function geniusSearchCb (r) {
      const hits = r.response.sections[0].hits
      if (hits.length === 0) {
        window.alert(custom.scriptName + '\n\nNo search results')
      } else {
        custom.listSongs(hits, container, query)
      }
    }, function geniusSearchErrorCb () {
      // do nothing
    })
  }

  function config () {
    loadCache()

    // Blur background
    for (const e of document.querySelectorAll('body > *')) {
      e.style.filter = 'blur(4px)'
    }
    const lyricscontainer = document.getElementById('lyricscontainer')
    if (lyricscontainer) {
      lyricscontainer.style.filter = 'blur(1px)'
    }

    const win = document.body.appendChild(document.createElement('div'))
    win.setAttribute('id', 'myconfigwin39457845')

    const h1 = document.createElement('h1')
    win.appendChild(h1)
    h1.textContent = 'Options'
    if ('scriptIssuesURL' in custom) {
      const a = document.createElement('a')
      a.href = custom.scriptIssuesURL
      win.appendChild(a)
      a.textContent = ('scriptIssuesTitle' in custom ? custom.scriptIssuesTitle : custom.scriptIssuesURL)
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
    label.textContent = ' Automatically show lyrics when new song starts'

    div.appendChild(document.createElement('br'))
    div.appendChild(document.createTextNode('(if you disable this, a small button will appear in the top right corner to show the lyrics)'))

    // Select: Theme
    div = win.appendChild(document.createElement('div'))
    div.textContent = 'Theme: '
    const selectTheme = div.appendChild(document.createElement('select'))
    for (const key in themes) {
      const option = selectTheme.appendChild(document.createElement('option'))
      option.value = key
      if (genius.option.themeKey === key) {
        option.selected = true
      }
      option.textContent = themes[key].name
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
    label.textContent = ' Show annotations'

    // Switch: Automatic scrolling
    div = win.appendChild(document.createElement('div'))
    const checkAutoScrollEnabled = div.appendChild(document.createElement('input'))
    checkAutoScrollEnabled.type = 'checkbox'
    checkAutoScrollEnabled.id = 'checkAutoScrollEnabled748'
    checkAutoScrollEnabled.checked = autoScrollEnabled === true
    const onAutoScrollEnabled = function onAutoScrollEnabledListener () {
      if (checkAutoScrollEnabled.checked !== autoScrollEnabled) {
        autoScrollEnabled = checkAutoScrollEnabled.checked === true
        custom.addLyrics(true)
        custom.GM.setValue('autoscrollenabled', autoScrollEnabled)
      }
    }
    checkAutoScrollEnabled.addEventListener('click', onAutoScrollEnabled)
    checkAutoScrollEnabled.addEventListener('change', onAutoScrollEnabled)

    label = div.appendChild(document.createElement('label'))
    label.setAttribute('for', 'checkAutoScrollEnabled748')
    label.textContent = ' Automatic scrolling'

    // Custom buttons
    if ('config' in custom) {
      for (const f of custom.config) {
        f(win.appendChild(document.createElement('div')))
      }
    }

    // Buttons
    div = win.appendChild(document.createElement('div'))

    const closeButton = div.appendChild(document.createElement('button'))
    closeButton.textContent = 'Close'
    closeButton.addEventListener('click', function onCloseButtonClick () {
      win.remove()
      // Un-blur background
      for (const e of document.querySelectorAll('body > *, #lyricscontainer')) {
        e.style.filter = ''
      }
    })

    // console.dir(selectionCache)
    // console.dir(requestCache)

    const bytes = metricPrefix(JSON.stringify(selectionCache).length + JSON.stringify(requestCache).length, 2, 1024) + 'Bytes'
    const clearCacheButton = div.appendChild(document.createElement('button'))
    clearCacheButton.textContent = `Clear cache (${bytes})`
    clearCacheButton.addEventListener('click', function onClearCacheButtonClick () {
      Promise.all([custom.GM.setValue('selectioncache', '{}'), custom.GM.setValue('requestcache', '{}')]).then(function () {
        clearCacheButton.innerHTML = 'Cleared'
        selectionCache = cleanSelectionCache()
        requestCache = {}
      })
    })

    const debugButton = div.appendChild(document.createElement('button'))
    debugButton.title = 'Do not enable this.'
    debugButton.style.float = 'right'
    const updateDebugButton = function () {
      if (genius.debug) {
        debugButton.innerHTML = 'Debug is on'
        debugButton.style.opacity = '1.0'
      } else {
        debugButton.innerHTML = 'Debug is off'
        debugButton.style.opacity = '0.2'
      }
    }
    updateDebugButton()
    debugButton.addEventListener('click', function onDebugButtonClick () {
      genius.debug = !genius.debug
      custom.GM.setValue('debug', genius.debug).then(function () {
        updateDebugButton()
      })
    })

    // Footer
    div = win.appendChild(document.createElement('div'))
    div.innerHTML = `<p style="font-size:15px;">
      Powered by <a style="font-size:15px;" target="_blank" href="https://github.com/cvzi/genius-lyrics-userscript/">GeniusLyrics.js</a>, Copyright © 2019 <a style="font-size:15px;" href="mailto:cuzi@openmail.cc">cuzi</a>.
      <br>Licensed under the GNU General Public License v3.0</p>`
  }

  function addOneMessageListener (type, cb) {
    let arr = onMessage[type]
    if (!arr) {
      arr = onMessage[type] = []
    }
    arr.push(cb)
  }

  function listenToMessages () {
    window.addEventListener('message', function (e) {
      const data = ((e || 0).data || 0)
      if (data.iAm !== custom.scriptName) {
        return
      }
      let arr = onMessage[data.type]
      if (arr && arr.length > 0) {
        let tmp = [...arr]
        arr.length = 0
        arr = null
        for (const cb of tmp) {
          if (typeof cb === 'function') {
            cb(e)
          }
        }
        tmp = null
      }
    })
  }

  function pageKeyboardEvent (keyParams, fct) {
    document.addEventListener('keypress', function onKeyPress (ev) {
      if (ev.key === keyParams.key && ev.shiftKey === keyParams.shiftKey &&
      ev.ctrlKey === keyParams.ctrlKey && ev.altKey === keyParams.altKey) {
        let e = ev.target
        while (e) {
          // Filter input, textarea, etc.
          if (typeof e.value !== 'undefined') {
            console.log(e)
            console.log(e.value)
            return
          }
          e = e.parentNode
        }
        return fct(ev)
      }
    })
  }

  function toggleLyrics () {
    const isLyricsIframeExist = !!document.getElementById('lyricsiframe')
    if (genius.iv.main > 0) {
      clearInterval(genius.iv.main)
      genius.iv.main = 0
    }
    if (!isLyricsIframeExist) {
      genius.option.autoShow = true // Temporarily enable showing lyrics automatically on song change
      if ('main' in custom) {
        custom.setupMain ? custom.setupMain(genius) : (genius.iv.main = setInterval(custom.main, 2000))
      }
      // if ('addLyrics' in custom) {
      //   custom.addLyrics(true)
      // }
      custom.addLyrics(true)
    } else {
      genius.option.autoShow = false // Temporarily disable showing lyrics automatically on song change
      // if ('hideLyrics' in custom) {
      //   custom.hideLyrics()
      // }
      hideLyricsWithMessage()
    }
  }

  function addKeyboardShortcut (keyParams) {
    window.addEventListener('message', function (e) {
      if (typeof e.data === 'object' && 'iAm' in e.data && e.data.iAm === custom.scriptName && e.data.type === 'togglelyrics') {
        toggleLyrics()
      }
    })
    pageKeyboardEvent(keyParams, function (ev) {
      toggleLyrics()
    })
  }

  function addKeyboardShortcutInFrame (keyParams) {
    pageKeyboardEvent(keyParams, function (ev) {
      if (window.parent) {
        window.parent.postMessage({ iAm: custom.scriptName, type: 'togglelyrics' }, '*')
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

  async function mainRunner () {
    // get values from GM
    const values = await Promise.all([
      custom.GM.getValue('debug', genius.debug),
      custom.GM.getValue('theme', genius.option.themeKey),
      custom.GM.getValue('annotationsenabled', annotationsEnabled),
      custom.GM.getValue('autoscrollenabled', autoScrollEnabled)
    ])

    // set up variables
    genius.debug = !!values[0]
    if (Object.prototype.hasOwnProperty.call(themes, values[1])) {
      genius.option.themeKey = values[1]
    } else {
      genius.option.themeKey = Reflect.ownKeys(themes)[0]
      custom.GM.setValue('theme', genius.option.themeKey)
      console.error(`Invalid value for theme key: custom.GM.getValue("theme") = '${values[1]}', using default theme key: '${genius.option.themeKey}'`)
    }
    theme = themes[genius.option.themeKey]
    annotationsEnabled = !!values[2]
    autoScrollEnabled = !!values[3]

    const isMessaging = document.location.href.startsWith(`${custom.emptyURL}#html:post`)

    // top
    if (!isMessaging) {
      listenToMessages()
      loadCache()
      addCss()
      if ('main' in custom) {
        custom.setupMain ? custom.setupMain(genius) : (genius.iv.main = setInterval(custom.main, 2000))
      }
      if ('onResize' in custom) {
        window.addEventListener('resize', custom.onResize)
      }
      if ('toggleLyricsKey' in custom) {
        addKeyboardShortcut(custom.toggleLyricsKey)
      }
      return
    }

    // iframe
    let e = await new Promise(resolve => {
      // only receive 'writehtml' message once
      let msgFn = function (e) {
        if ((((e || 0).data || 0).iAm) === custom.scriptName && e.data.type === 'writehtml') {
          window.removeEventListener('message', msgFn, false)
          msgFn = null
          const { data, source } = e
          resolve({ data, source })
        }
      }
      window.addEventListener('message', msgFn, false)
      try {
        // faster than setInterval
        top.postMessage({ iAm: custom.scriptName, type: 'genius-iframe-waiting' }, '*')
      } catch (e) {
        // in case top is not accessible from iframe
      }
    })

    if ('themeKey' in e.data && Object.prototype.hasOwnProperty.call(themes, e.data.themeKey)) {
      genius.option.themeKey = e.data.themeKey
      theme = themes[genius.option.themeKey]
      console.debug(`Theme activated in iframe: ${theme.name}`)
    }

    document.documentElement.innerHTML = e.data.html
    const communicationWindow = e.source
    communicationWindow.postMessage({ iAm: custom.scriptName, type: 'htmlwritten' }, '*')

    // clean up
    e = null

    // delay 500ms
    await new Promise(resolve => setTimeout(resolve, 500))

    const onload = theme.scripts()
    if ('iframeLoadedCallback1' in custom) {
      // before all onload functions and allow modification of theme and onload from external
      custom.iframeLoadedCallback1({ document, theme, onload })
    }
    for (const func of onload) {
      try {
        func()
      } catch (e) {
        console.error(`Error in iframe onload ${func.name || func}: ${e}`)
      }
    }
    // Scroll lyrics event
    if ('scrollLyrics' in theme) {
      window.addEventListener('message', function (e) {
        if (typeof e.data !== 'object' || !('iAm' in e.data) || e.data.iAm !== custom.scriptName || e.data.type !== 'scrollLyrics' || !('scrollLyrics' in theme)) {
          return
        }
        theme.scrollLyrics(e.data.position)
      })
    }
    if ('toggleLyricsKey' in custom) {
      addKeyboardShortcutInFrame(custom.toggleLyricsKey)
    }
    // this page is generated by code; pageready does not mean the page is fully rendered
    communicationWindow.postMessage({ iAm: custom.scriptName, type: 'pageready'/* , html: document.documentElement.innerHTML */ }, '*')
    if ('iframeLoadedCallback2' in custom) {
      // after all onload functions
      custom.iframeLoadedCallback2({ document, theme, onload })
    }
  }

  mainRunner()

  return genius
}
