// ==UserScript==
// @exclude      *
// ==UserLibrary==
// @name         GeniusLyrics
// @description  Downloads and shows genius lyrics for Tampermonkey scripts
// @version      5.6.0
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

  function unScroll() { // unable to do delete window.xxx
    // only for mainWin
    window.lastScrollTopPosition = null
    window.scrollLyricsBusy = false
    window.staticOffsetTop = null
    window.latestScrollPos = null
    window.newScrollTopPosition = null
    window.isPageAbleForAutoScroll = null
  }
  function hideLyricsWithMessage () {
    const ret = custom.hideLyrics(...arguments)
    if (ret === false) { // cancelled
      return false
    }
    unScroll()
    window.postMessage({ iAm: custom.scriptName, type: 'lyricsDisplayState', visibility: 'hidden' }, '*')
    return ret
  }

  function cancelLoading () {
    window.postMessage({ iAm: custom.scriptName, type: 'cancelLoading' }, '*')
  }

  const __SELECTION_CACHE_VERSION__ = 1
  const __REQUEST_CACHE_VERSION__ = 1

  const genius = {
    option: {
      autoShow: true,
      themeKey: null,
      cacheHTMLRequest: true, // be careful of cache size if trimHTMLReponseText is false; around 50KB per lyrics including selection cache
      requestCallbackResponseTextOnly: true, // default true; just need the request text
      enableStyleSubstitution: false, // default false; some checking are provided but not guaranteed
      trimHTMLReponseText: true, // make html request to be smaller for caching and window messaging; safe to enable
      defaultPlaceholder: 'Search genius.com...' // placeholder for input field
    },
    f: {
      metricPrefix,
      cleanUpSongTitle,
      showLyrics,
      showLyricsAndRemember,
      reloadCurrentLyrics,
      loadLyrics,
      hideLyricsWithMessage,
      cancelLoading,
      rememberLyricsSelection,
      isGreasemonkey,
      forgetLyricsSelection,
      forgetCurrentLyricsSelection,
      getLyricsSelection,
      geniusSearch,
      searchByQuery,
      isScrollLyricsEnabled, // refer to user setting
      isScrollLyricsCallable, // refer to content rendering
      scrollLyrics,
      config
    },
    current: { // store the title and artists of the current lyrics [cached and able to reload]
      title: '',
      artists: ''
    },
    iv: {
      main: null // unless setupMain is provided and the interval / looping is controlled externally
    },
    style: {
      enabled: false // true to make the iframe content more compact and concise; [only work on Genius Default Theme?]
    },
    styleProps: { // if style.enabled, feed the content style into styleProps
    },
    minimizeHit: { // minimize the hit for smaller caches; default all false
      noImageURL: false,
      noFeaturedArtists: false,
      simpleReleaseDate: false,
      noRawReleaseDate: false,
      shortenArtistName: false,
      fixArtistName: false,
      removeStats: false, // note: true for YoutubeGeniusLyrics only
      noRelatedLinks: false,
      onlyCompleteLyrics: false
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
          if (genius.option.requestCallbackResponseTextOnly === true) {
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
      if (genius.minimizeHit.onlyCompleteLyrics === true && hit.result.lyrics_state !== 'complete') return false
      return true
    })

    for (const hit of hits) {
      const result = hit.result
      if (!result) return
      const primaryArtist = result.primary_artist || 0
      const minimizeHit = genius.minimizeHit
      const isGeniusTranslationLike = primaryArtist && (primaryArtist.slug||'').startsWith('Genius-') && hit.result.language !== 'romanization'
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
        if (isGeniusTranslationLike) {
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
      const btnContainer = document.querySelector('#resumeAutoScrollButtonContainer')

      if (newScrollTop > maxScrollTop) {
        newScrollTop = maxScrollTop
      } else if (newScrollTop < 0) {
        newScrollTop = 0
      }

      if (lastPos > 0 && Math.abs(lastPos - document.scrollingElement.scrollTop) > 5) { // lastPos !== null
        if (!force && document.visibilityState === 'visible') {
          // the scrolltop is updating by scrollTo({behavior:'smooth'})
          delayScrolling(scrollLyricsGeneric)
          return
        }
        window.staticOffsetTop = staticTop
        window.newScrollTopPosition = newScrollTop
        function setArrowUpDownStyle (resumeButton) {
          if (!resumeButton) return
          const oldAttribute = resumeButton.getAttribute('arrow-icon')
          const newAttribute = (document.scrollingElement.scrollTop - window.newScrollTopPosition < 0) ? 'up' : 'down'
          if (oldAttribute !== newAttribute) {
            resumeButton.setAttribute('arrow-icon', newAttribute)
          }
        }
        // User scrolled -> stop auto scroll
        if (!btnContainer) {
          const resumeButton = document.createElement('div')
          const resumeButtonFromHere = document.createElement('div')
          const resumeAutoScrollButtonContainer = document.createElement('div')
          resumeAutoScrollButtonContainer.id = 'resumeAutoScrollButtonContainer'
          resumeButton.addEventListener('click', function resumeAutoScroll () {
            window.scrollLyricsBusy = true
            resumeAutoScrollButtonContainer.classList.remove('btn-show')
            window.lastScrollTopPosition = null
            // Resume auto scrolling
            document.scrollingElement.scrollTo({
              top: window.newScrollTopPosition,
              behavior: 'smooth'
            })
            setTimeout(() => {
              window.scrollLyricsBusy = false
            }, 100)
          })
          resumeButtonFromHere.addEventListener('click', function resumeAutoScrollFromHere () {
            window.scrollLyricsBusy = true
            resumeAutoScrollButtonContainer.classList.remove('btn-show')
            // Resume auto scrolling from current position
            if (genius.debug) {
              for (const e of document.querySelectorAll('.scrolllabel')) {
                e.remove()
              }
              window.first = false
            }
            window.lastScrollTopPosition = null
            window.staticOffsetTop += document.scrollingElement.scrollTop - window.newScrollTopPosition
            setTimeout(() => {
              window.scrollLyricsBusy = false
            }, 30)
          })
          resumeButton.id = 'resumeAutoScrollButton'
          resumeButton.setAttribute('title', 'Resume auto scrolling')
          resumeButton.appendChild(document.createElement('div'))
          setArrowUpDownStyle(resumeButton)
          resumeButtonFromHere.id = 'resumeAutoScrollFromHereButton'
          resumeButtonFromHere.setAttribute('title', 'Resume auto scrolling from here')
          resumeButtonFromHere.appendChild(document.createElement('div'))
          setTimeout(() => {
            if (newScrollTop > 0 && newScrollTop < maxScrollTop) {
              resumeAutoScrollButtonContainer.classList.add('btn-show')
            }
            window.scrollLyricsBusy = false
          }, 40)

          appendElements(resumeAutoScrollButtonContainer, [resumeButton, resumeButtonFromHere])
          document.body.appendChild(resumeAutoScrollButtonContainer)
        } else {
          const resumeButton = document.querySelector('#resumeAutoScrollButton')
          setArrowUpDownStyle(resumeButton)
          window.scrollLyricsBusy = false
          setTimeout(() => {
            if (newScrollTop > 0 && newScrollTop < maxScrollTop) {
              btnContainer.classList.add('btn-show')
            }
            window.scrollLyricsBusy = false
          }, 40)
        }
        return
      }

      if (btnContainer) {
        btnContainer.classList.remove('btn-show')
        btnContainer.classList.remove('btn-show')
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
    lyricsAppInit () {
      let application = document.querySelector('#application')
      if (application !== null) {
        application.classList.add('app11')
      }
      application = null
    },
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

  const iframeCSSCommon =
  `
  html {
    --ygl-btn-half-border-size: 7px;
    --ygl-btn-color: #222;
  }

  #resumeAutoScrollButtonContainer{
    position: fixed; 
    right: 20px; 
    top: 30%; 
    z-index: 101; 
    display: flex;
    flex-direction: row;
    gap: 4px;
  }

  #resumeAutoScrollButtonContainer #resumeAutoScrollButton,
  #resumeAutoScrollButtonContainer #resumeAutoScrollFromHereButton{
    cursor: pointer;
    border: 1px solid #d9d9d9;
    border-radius:100%;
    background:white;
    display: flex;
    justify-content: center;
    align-content: center;
    justify-items: center;
    align-items: center;
    padding: calc(1.732*var(--ygl-btn-half-border-size) + 3px);
    contain: strict;
  }

  #resumeAutoScrollButtonContainer {
    visibility: hidden;
    pointer-events: none;
    visibility: collapse; /* if collapse is supported, hidden + no pointer events */
  }
  #resumeAutoScrollButtonContainer.btn-show {
    visibility: visible;
    pointer-events: initial;
  }

  #resumeAutoScrollButton > div:only-child {
    position: absolute;
    contain: strict;
  }
  #resumeAutoScrollButton[arrow-icon="up"] > div:only-child {
    border-top: calc(1.732*var(--ygl-btn-half-border-size)) solid var(--ygl-btn-color);
    border-right: var(--ygl-btn-half-border-size) inset transparent;
    border-bottom: 0;
    border-left: var(--ygl-btn-half-border-size) inset transparent;
  }
  #resumeAutoScrollButton[arrow-icon="down"] > div:only-child {
    border-top: 0;
    border-right: var(--ygl-btn-half-border-size) inset transparent;
    border-bottom: calc(1.732*var(--ygl-btn-half-border-size)) solid var(--ygl-btn-color);
    border-left: var(--ygl-btn-half-border-size) inset transparent;
  }

  #resumeAutoScrollFromHereButton > div:only-child {
    position: absolute;
    contain: strict;
    border-top: var(--ygl-btn-half-border-size) inset transparent;
    border-right: 0;
    border-bottom: var(--ygl-btn-half-border-size) inset transparent;
    border-left: calc(1.732*var(--ygl-btn-half-border-size)) solid var(--ygl-btn-color);
  }
  
  body div[class*="__Container"] iframe,
  body div[class*="__Container"] div[class*="_preview"] iframe,
  body div[class*="__Container"] div[class*="embed"] iframe {
    /* override .hPdMCA .embedly_preview iframe {display: block;} */
    display: none;
    position: absolute;
    top: 0;
    right: 0;
    width: 0;
    height: 0;
  }
  
  @keyframes appDomAppended {
    0% {
      background-position-x: 1px;
    }
  
    100% {
      background-position-x: 2px;
    }
  }

  @keyframes appDomAppended2 {
    0% {
      background-position-x: 3px;
    }
  
    100% {
      background-position-x: 4px;
    }
  }

  @keyframes songHeaderDomAppended {
    0% {
      background-position-x: 1px;
    }
  
    100% {
      background-position-x: 2px;
    }
  }

  #application {
    animation: appDomAppended 1ms linear 0s 1 normal forwards;
  }

  #application.app11 {
    animation: appDomAppended2 1ms linear 0s 1 normal forwards;
  }

  #application.app11 div[class*="SongHeaderWithPrimis__Container"] > div[class*="SongHeaderWithPrimis__Right"] {
    animation: songHeaderDomAppended 1ms linear 0s 1 normal forwards;
  }
  `

  function setAnnotationsContainerTop (c, a, isContentChanged) {
    const rect = a.getBoundingClientRect()
    const bodyH = document.scrollingElement.clientHeight

    let upSpace = Math.max(rect.top, 0)
    let downSpace = bodyH - Math.min(rect.bottom, bodyH)

    if (isContentChanged) {
      c.style.setProperty('--annotation-container-syrt', `${window.scrollY + rect.top}px`)
      c.style.setProperty('--annotation-container-rh', `${rect.height}px`)
    }

    if (downSpace > upSpace) {
      c.setAttribute('location-dir', 'down')
    } else {
      c.setAttribute('location-dir', 'up')
    }
  }

  function scrollUpdateLocationHandler () {
    window.requestAnimationFrame(() => {
      let c = document.querySelector('#annotationcontainer958[style*="display: block;"]')
      if (c !== null) {
        let a = document.querySelector('.annotated.highlighted')
        if (a !== null) {
          setAnnotationsContainerTop(c, a, false)
        }
      }
    })
  }

  const themes = {
    genius: {
      name: 'Genius (Default)',
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

        function setScrollUpdateLocation () {
          document.addEventListener('scroll', scrollUpdateLocationHandler, false)
        }

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
              z-index:4;
            }
            #annotationcontainer958 .arrow {
              height:30px;
              background: white;
            }
            #annotationcontainer958 .arrow:before {
              content: "";
              position: absolute;
              width: 0px;
              height: 0px;
              margin-top: 6px;
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
            #annotationcontainer958 .annotationcontent .annotation-img-parent-p {
              display: flex;
              justify-content: center;
              align-content: center;
              margin: 6px;
            }
            #annotationcontainer958 .annotationcontent .annotation-img-parent-p > img[src][width][height]:only-child{
              object-fit: contain;
              height: auto;
            }
            #annotationcontainer958[location-dir="down"]{
              transform: '';
              top: calc(var(--annotation-container-syrt) + var(--annotation-container-rh) + 3px);         
            }
            #annotationcontainer958[location-dir="up"]{
              transform: translateY(-100%);
              top: calc(var(--annotation-container-syrt) - 3px - 18px);  window.scrollY + rect.top - 3 - 18);
            }
          `
            setScrollUpdateLocation(c)
          }
          c.innerHTML = ''

          c.style.display = 'block'
          c.style.opacity = 1.0
          setAnnotationsContainerTop(c, a, true)


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
              const maxWidth = (document.body.clientWidth - 40)
              const elements = annotationContent.querySelectorAll('iframe,img')
              for (const e of elements) {
                if (e.parentNode.nodeName === 'P' && e.parentNode.childElementCount === 1) {
                  e.parentNode.classList.add('annotation-img-parent-p')
                  e.style.maxWidth = `${maxWidth - 60}px`
                } else {
                  e.style.maxWidth = `${maxWidth}px`
                }
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
          a[href].annotated {
            display: inline-block; /* make the whole <a> clickable; including gap between lines*/
          }
          ${iframeCSSCommon}
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
      combine: function themeCleanWhiteCombineGeniusResources (song, html, annotations, onCombine) {
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
            ${iframeCSSCommon}
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
        
          ${iframeCSSCommon}
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
      combine: function themeSpotifyCombineGeniusResources (song, html, annotations, onCombine) {
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
            ${iframeCSSCommon}
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
          ${iframeCSSCommon}
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

      function isFuzzyMatched (hits) {
        // if first hit's _order is the only highest, consider it as fuzzy matched
        if (!hits) return null
        return hits[0] && hits[1] && hits[0]._order > hits[1]._order && hits[1]._order > 0
      }

      function resultMsg (hits, ...args) {
        console.log(...args)
        console.log(hits)
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
              resultMsg(hits, `Genius Lyrics - exact match is found in ${hits.length} results.`)
              showLyricsAndRemember(mTitle, mArtists, exactMatches[0], hits.length)
            } else if (isFuzzyMatched(hits)) {
              resultMsg(hits, `Genius Lyrics - fuzzy match is found in ${hits.length} results.`)
              showLyricsAndRemember(mTitle, mArtists, hits[0], hits.length)
            } else {
              multipleResultsFound(hits, mTitle, mArtists)
            }
          } else {
            if (isFuzzyMatched(hits)) {
              resultMsg(hits, `Genius Lyrics - fuzzy match is found in ${hits.length} results.`)
              showLyricsAndRemember(mTitle, mArtists, hits[0], hits.length)
            } else {
              resultMsg(hits, 'Genius Lyrics - lyrics results with multiple artists are found.', hits.length, songArtistsArr)
              multipleResultsFound(hits, mTitle, mArtists)
            }
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

  function defaultCSS (html) { // independent of iframe or main window
    // use with contentStyling
    // cache might have REPXn
    // if(genius.option.enableStyleSubstitution !== true) return html

    /* CSS minimized via https://css-minifier.com/ with discard invalid CSS 3.0; high moderate readability, smaller size */
    const defaultCSSTexts = [
      `
      @font-face{font-family:'Programme';src:url(https://assets.genius.com/fonts/programme_bold.woff2?1671208854) format("woff2"),url(https://assets.genius.com/fonts/programme_bold.woff?1671208854) format("woff");font-style:normal;font-weight:700}
@font-face{font-family:'Programme';src:url(https://assets.genius.com/fonts/programme_normal.woff2?1671208854) format("woff2"),url(https://assets.genius.com/fonts/programme_normal.woff?1671208854) format("woff");font-style:normal;font-weight:400}
@font-face{font-family:'Programme';src:url(https://assets.genius.com/fonts/programme_normal_italic.woff2?1671208854) format("woff2"),url(https://assets.genius.com/fonts/programme_normal_italic.woff?1671208854) format("woff");font-style:italic;font-weight:400}
@font-face{font-family:'Programme';src:url(data:font/woff2;base64,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) format("woff2"),url(https://assets.genius.com/fonts/programme_light.woff?1671208854) format("woff");font-style:normal;font-weight:100}
@font-face{font-family:'Programme';src:url(https://assets.genius.com/fonts/programme_light_italic.woff2?1671208854) format("woff2"),url(https://assets.genius.com/fonts/programme_light_italic.woff?1671208854) format("woff");font-style:italic;font-weight:100}
      `,
      ` .kiNXoS{position:relative;display:-webkit-box;width:100%;line-height:0}
/*.hOMcjE{position:relative;display:-webkit-box;width:100%;height:415px;line-height:0}*/
.dTXQYT{position:relative;display:-webkit-box;width:100%;height:250px;line-height:0}
.ilfajN{position:absolute;left:50%;transform:translateX(-50%);background:#e9e9e9}
/*.hoVEOg{position:absolute;left:50%;transform:translateX(-50%);width:300px;height:250px;background:#e9e9e9}*/
.bIwkeM{position:absolute;left:50%;transform:translateX(-50%);width:728px;height:90px;background:#e9e9e9}
/*.fgEzTD{position:absolute;left:50%;transform:translateX(-50%);background:#64321d}*/
.dIgauN{width:100%}
.jOhzET{background-color:#000;min-height:calc(3rem + 90px);display:-webkit-box}
/*.kNjZBr{font-size:.75rem;font-weight:100;line-height:1;letter-spacing:1px;text-transform:capitalize;color:#fff}*/
.kokouQ{font-size:.75rem;font-weight:400;line-height:1;letter-spacing:1px;text-transform:uppercase;color:#fff}
.xQwqG svg{height:1.33em;margin-left:calc(-1em * 0.548625);vertical-align:top}
.xQwqG::before{content:'\\2003';font-size:.548625em}
/*.gLmHNs{font-weight:100;color:inherit}*/
/*.PcIZE{font-size:1rem;font-weight:100;text-decoration:underline;color:inherit}
.PcIZE:hover{text-decoration:none}*/
/*.fUgcxf{font-weight:100;text-decoration:underline;color:inherit}
.fUgcxf:hover{text-decoration:none}
.fTLMop{font-weight:100;text-decoration:underline;color:inherit}
.fTLMop:hover{text-decoration:none}*/
.lbozyU{line-height:13px}
.lbozyU svg{position:relative;top:1px;height:13px}
.jDxAhO svg{display:block;height:2.25rem;margin:auto;width:2.25rem}
.jDxAhO svg circle{animation:hFBEL 2s ease-out infinite;background-color:inherit}
.iMdmgx:not([src]){visibility:hidden}
.dawSPu{display:-webkit-box;background:#fff;width:calc(10 * 1rem + .75rem);height:1.5rem}
.dawSPu .PageHeadershared__Dropdown-sc-1cjax99-1{right:0}
.cmIqeW{display:-webkit-box;position:relative;cursor:pointer;padding:0 .75rem}
.cmIqeW svg{width:.625rem}
.hTPksM{position:relative;border:none;border-radius:0;background:#fff;color:#000;font-family:'Programme',Arial,sans-serif;font-size:inherit;font-weight:inherit;line-height:inherit;overflow:hidden;resize:none;outline:none;padding-left:.75rem}
.hTPksM::-webkit-input-placeholder,.hTPksM::-webkit-input-placeholder{color:#000;font-size:.75rem}
.hTPksM::-moz-placeholder,.hTPksM::-webkit-input-placeholder{color:#000;font-size:.75rem}
.hTPksM:-ms-input-placeholder,.hTPksM::-webkit-input-placeholder{color:#000;font-size:.75rem}
.hTPksM::placeholder,.hTPksM::-webkit-input-placeholder{color:#000;font-size:.75rem}
.hTPksM::-ms-input-placeholder{color:#000;font-size:.75rem}
.hTPksM:focus::-webkit-input-placeholder{color:#9a9a9a;font-size:.75rem}
.hTPksM:focus::-moz-placeholder{color:#9a9a9a;font-size:.75rem}
.hTPksM:focus:-ms-input-placeholder{color:#9a9a9a;font-size:.75rem}
.hTPksM:focus::placeholder{color:#9a9a9a;font-size:.75rem}
.hVAZmF{font-family:inherit;font-size:inherit;font-weight:inherit;color:inherit;line-height:1}
.cLBJdA{width:auto;background-color:transparent;border-radius:1.25rem;padding:.5rem 1.313rem;border:1px solid #000;font-family:'HelveticaNeue',Arial,sans-serif;font-size:1rem;font-weight:400;line-height:1.1;color:#000;cursor:pointer}
.cLBJdA:hover{background-color:#000;color:#fff}
.cLBJdA:hover span{color:#fff}
/*.kPiSeV{width:auto;background-color:transparent;border-radius:1.25rem;padding:.5rem 1.313rem;border:1px solid #fff;font-family:'HelveticaNeue',Arial,sans-serif;font-size:1rem;font-weight:400;line-height:1.1;color:#fff;cursor:pointer}
.kPiSeV:hover{background-color:#fff;color:#000}
.kPiSeV:hover span{color:#000}*/
/*.ikBeYr{font-size:.75rem;font-weight:100;line-height:1;letter-spacing:1px;text-transform:capitalize;color:#fff}*/
/*.hOzYYd{display:-webkit-box;font-weight:100;font-size:.75rem;height:3rem;background-color:#d62d36;color:#fff;position:-webkit-sticky;top:calc(0);z-index:6}*/
.cpvLYi{display:-webkit-box;margin-left:1rem}
.kMDkxm{position:relative;display:-webkit-box;margin-right:1rem}
/*.kphUUq{margin-right:1.5rem;line-height:1.33;color:#fff}
.kphUUq span{white-space:nowrap;color:#fff}
.kphUUq:hover{text-decoration:underline}*/
/*.kYaBCH{margin-right:1.5rem;line-height:1.33;color:#fff}
.kYaBCH span{white-space:nowrap;color:#fff}
.kYaBCH:hover{text-decoration:underline}*/
.leLkHK{display:-webkit-box;margin-left:2.25rem}
.cRrFdP{display:block;position:relative}
.dvOJud{cursor:pointer}
.fqAixv{display:-webkit-box;width:100%;margin-bottom:1rem}
.cVGQZE{line-height:1.33;white-space:nowrap}
.eRbhLo{position:relative;display:-webkit-box;column-gap:1.5rem}
/*.hxSUxL{font-weight:100;font-size:.75rem;line-height:1.33;color:#fff;max-width:50%}*/
/*.repVv{display:block;line-height:1.2;font-size:.75rem;color:#fff}*/
/*.eOxYeV{font-size:1rem}*/
/*.kviCal{display:-webkit-box;border-radius:1.25rem;padding:.25rem .75rem;border:1px solid #000;font-family:'HelveticaNeue',Arial,sans-serif;font-size:.75rem;color:#000;line-height:1.125}
.kviCal:disabled{opacity:.5}
.kviCal:hover:not(:disabled){background-color:#000;color:#fff}
.kviCal:hover:not(:disabled) span{color:#fff}*/
/*.kTUFzk{height:1rem;vertical-align:text-top}*/
/*.fxOdHk{position:relative}*/
/*.hIOhEv{display:none}*/
/*.chZLLf{display:block;height:100%}*/
/*.jzPNvv{text-align:center;color:#fff}
.jzPNvv .ExpandableContent__TextButton-sc-1165iv-2{margin-top:.75rem}
.jzPNvv .ExpandableContent__TextButton-sc-1165iv-2,.jzPNvv .ExpandableContent__Button-sc-1165iv-1{line-height:1.25}*/
.huhsMa{overflow:hidden;max-height:250px}
/*.exCHLx{display:-webkit-box;font-size:.75rem;font-family:'Programme',Arial,sans-serif;color:#fff}
.exCHLx svg{display:block;height:1.2em}
.exCHLx:disabled{color:#9a9a9a}*/
.dCKKNS{display:-webkit-box;font-size:.75rem;font-family:'Programme',Arial,sans-serif;color:#000}
.dCKKNS svg{display:block;height:.75rem}
.dCKKNS:disabled{color:#9a9a9a}
.kMItKF{text-decoration:none;font-weight:100;font-size:.75rem;margin-left:.25rem;color:inherit}
.gjSNHg{text-decoration:underline;font-weight:100;font-size:.75rem;margin-left:.25rem;color:inherit}
.gjSNHg:hover{text-decoration:none}
.itbKya{appearance:none;border-radius:0;margin:0;background:inherit;border:1px solid #000;padding:.75rem;color:#000;font-size:1rem;font-family:'HelveticaNeue',Arial,sans-serif;font-weight:100;overflow-y:auto;resize:vertical;display:block;width:100%}
.itbKya:disabled{opacity:.3;background-image:url(data:image/svg+xml,%3Csvg%20viewBox%3D%220%200%2011%2015%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Cpath%20fill-rule%3D%22evenodd%22%20fill%3D%22%23000%22%20clip-rule%3D%22evenodd%22%20d%3D%22M1.642%206.864H.369V14.5h10.182V6.864H9.278V4.318a3.818%203.818%200%200%200-7.636%200v2.546zm1.272%200h5.091V4.318a2.546%202.546%200%200%200-5.09%200v2.546z%22%2F%3E%3C%2Fsvg%3E);background-size:.625rem auto;background-position:calc(100% - .5rem + 1px) center;background-repeat:no-repeat;padding-right:calc(.75rem * 2 + .625rem)}
.itbKya::-webkit-input-placeholder{color:rgba(0,0,0,0.5)}
.itbKya::-moz-placeholder{color:rgba(0,0,0,0.5)}
.itbKya:-ms-input-placeholder{color:rgba(0,0,0,0.5)}
.itbKya::placeholder{color:rgba(0,0,0,0.5)}
.eMjKRh{position:relative}
.eQViPi{display:-webkit-box}
.ctylSH{display:-webkit-box;margin-left:auto}
/*.fcQQLw{display:-webkit-box}
.fcQQLw>:not(:last-child){margin-right:1.5rem}*/
.fzwKEO svg{height:1.2em;width:1.2em}
.gAieh svg{height:1.2em;width:1.2em}
/*.cujBpY{display:-webkit-box;padding:1.5rem 0;transform-origin:top;transition-property:transform,max-height,padding,opacity;transition-duration:100ms;transition-timing-function:ease;transform:none;max-height:100vh;opacity:1}
.cujBpY .desktop_song_inread_prebid_container,.cujBpY .desktop_song_inread2_prebid_container,.cujBpY .desktop_song_inread3_prebid_container{margin:auto}*/
.csMTdh{width:100%}
.jecoie{display:grid}
/*.hshFQG{z-index:1;background-image:linear-gradient(#d62d36,#64321d);padding-top:.75rem;padding-bottom:1.5rem;position:relative;color:#fff}*/
.jiZgac{width:100%;height:100%;position:relative;z-index:1;display:-webkit-box}
.brVVKA{display:-webkit-box}
.iMmhUH{display:-webkit-box}
.iFxQsP{display:-webkit-box;max-width:32rem}
.hudniQ{margin-top:.75rem;margin-right:.75rem;width:100%}
@media screen and (min-width:1164px) {
.hudniQ{max-height:calc(100% + 1.5rem)}
}
.dnpvgJ img{display:inline-block;box-shadow:0 0 .75rem 0 rgba(0,0,0,0.05)}
@media screen and (min-width:1164px) {
.dnpvgJ{height:100%;text-align:right}
.dnpvgJ img{max-height:100%}
}
/*.fpQGbx{display:-webkit-box;font-size:1.5rem;font-weight:400;color:#fff;line-height:1.125;word-wrap:break-word}*/
.jSgIpQ{opacity:1}
.fmRrc{position:absolute;width:100%;bottom:calc(0 + 3rem);z-index:-2}
.iEXgTT{width:100%}
.heddkF{margin-left:1.5rem;width:400px;min-width:400px;max-width:400px}
.ENCiS{position:absolute;top:calc(100vh - (0 + 3rem));bottom:0;width:100%;z-index:-2}
.iwZJzz{display:-webkit-box;column-gap:1rem}
/*.kEyJXB{z-index:3;background-color:#fff;margin-top:1rem;padding:.375rem 0;font-size:.75rem;position:absolute;border:1px solid #000;min-width:100%;cursor:pointer;white-space:nowrap;left:0}
.kEyJXB:before{content:'';position:absolute;width:8px;height:8px;background-color:#fff;border-top:1px solid #000;border-right:1px solid #000;top:0;left:50%;transform:translateX(-50%) translateY(calc(-50% - 1px)) rotate(-45deg)}*/
/*.enfGY{color:#000}
.enfGY:hover{color:#fff;background-color:#000}*/
/*.dLSCVn{margin-left:.375rem}
.dLSCVn svg{width:.375rem}*.
/*.hXTHjZ{display:block;width:100%;padding:.375rem .5rem}*/
/*.smKwV{line-height:1rem}*/
/*.fuMyZH{max-width:25ch;word-wrap:break-word;word-break:break-word;overflow:hidden;white-space:nowrap}*/
.bBMTMQ{display:-webkit-box;margin:1rem 0 0}
.bBMTMQ:empty{display:none}
.dyewdM{margin-bottom:1.5rem;width:100%;font-weight:100;font-size:.75rem}
@media screen and (min-width:1164px) {
.dyewdM{font-size:1rem}
}
.ePvBqA{display:-webkit-box}
.kJxpEi{display:-webkit-box;font-size:inherit;line-height:1;font-family:'Programme',Arial,sans-serif;font-weight:100;white-space:pre}
.kJxpEi svg{display:block;height:1rem}
.ueUKD{text-align:center;font-size:inherit}
.ueUKD .react-share__ShareButton{width:100%}
.fraZOY{height:100%;width:300px;min-height:calc(px + 0.75rem);max-height:50%;padding-top:.75rem}
/*.cFlBmm{height:100%;width:300px;display:-webkit-box;margin:.75rem 0}*/
.kMKmmz{height:100%;width:300px;min-height:calc(px + 0.75rem);max-height:calc(100% - (0 + 3rem + 0.75rem));padding-top:.75rem}
.hQgDBO{position:-webkit-sticky;top:calc(0 + 3rem + 0.75rem)}
.fUyrrM{border:1px solid #000;font-size:.75rem;width:100%}
.fVWWod{display:-webkit-box}
.lfAvEQ{background:#000;color:#fff;font-size:1rem;padding:.25rem 1rem}
.fdEmdh{font-size:.75rem;font-weight:100;line-height:1;letter-spacing:1px;text-transform:none;color:#000;margin-top:.75rem}
.fHdUT{display:grid;font:100 1.125rem/1.5 Programme,Arial,sans-serif;padding:0;min-height:min(var(--annotation-height),100vh);position:relative;width:100%;word-wrap:break-word;word-break:break-word}
.jrjShc{display:-webkit-box}
.kuxJDq.kuxJDq{margin:.75rem}
.YYrds{padding-top:.5rem;padding-bottom:1.5rem;padding-right:1.5rem}
.fMoZxb{position:-webkit-sticky;top:calc(0 + 3rem + 0.75rem);margin-top:1rem;margin-bottom:1.5rem}
.hXQMRu{font-size:.75rem}
.hXQMRu ul{padding-left:1rem;margin-bottom:1rem}
.hXQMRu li{list-style-type:disc}
.eDBQeK{font-weight:700}
.rncXA{font-style:italic}
.kkpCaw{display:none;font-weight:100;margin-bottom:3rem}
.eqRvkr{border-bottom:1px solid #000;margin-bottom:1.313rem;background-color:#e9e9e9;padding-top:2.25rem}
.bcLwQh{padding-bottom:.75rem}
.hFPGxa{position:relative}
.lbdVJq{margin-left:1.313rem}
.hGLtDM{position:-webkit-sticky;top:calc(0 + 3rem + 2.25rem)}
.bXbziL{display:-webkit-box;padding:.5rem 1rem;margin:0}
.ldjaSd{margin-top:1.313rem}
.cSKAwQ{display:grid;background-color:#000}
.fPpEQG{padding:.75rem 0}
/*.hYPlhL{color:#fff}*/
/*.DOZxe{text-align:center;color:#fff;margin-bottom:1.313rem}*/
/*.kiBT{font-size:1rem;border:1px solid #fff;color:#fff;padding:.75rem;width:100%;text-align:left;cursor:text}*/
/*.iyrTpw{border-bottom:1px solid #fff;margin-bottom:3rem;padding-bottom:3rem}*/
.vrxkS{border-bottom:1px solid #000;margin-bottom:3rem;padding-bottom:3rem}
.cabqMy .Fieldshared__FieldControlWithLabel-dxskot-1{display:-webkit-box}
.cabqMy .Fieldshared__FieldLabel-dxskot-2{transition:all .2s}
.cabqMy input:placeholder-shown+.Fieldshared__FieldLabel-dxskot-2{cursor:text;transform-origin:left bottom;transform:translate(.75rem,2.5rem)}
.cabqMy input:focus+.Fieldshared__FieldLabel-dxskot-2,.cabqMy input:not(:placeholder-shown)+.Fieldshared__FieldLabel-dxskot-2{transform:translate(0,0)}
.fyUjsz{display:-webkit-box;margin-bottom:.25rem;font-weight:100;font-size:1rem}
/*.llwCwW{font-size:1rem;border:1px solid #fff;color:#fff;padding:.75rem;width:100%;text-align:left;cursor:text}*/
.esoPOn{font-size:2.25rem;font-weight:400;margin-bottom:1.313rem;line-height:1.1}
/*.gatDgA{position:relative;font-weight:100;color:#fff}*/
.uEMeZ{position:absolute;top:calc(-1.5 * (0 + 3rem))}
.ceKRFE{font-size:.625rem;margin:.75rem 0;text-align:left}
.bZsZHM{display:-webkit-box}
/*.evrydK{color:#fff;border:1px solid #fff;padding:.5rem;font-size:.75rem;font-weight:700}
.evrydK:visited{color:#fff}
.evrydK:hover{background-color:#fff;color:#000}
.evrydK:hover span{color:#000}*/
/*.kykqAa{color:#fff;border:1px solid #fff;padding:.5rem;font-size:.75rem}
.kykqAa:visited{color:#fff}
.kykqAa:hover{background-color:#fff;color:#000}
.kykqAa:hover span{color:#000}*/
/*.kJtCmu{position:relative;font-weight:100;padding:0 1.313rem;color:#fff}*/
.iRKrFW{font-size:2.25rem;font-weight:400;margin-bottom:2.25rem;line-height:1.1}
.dWcYSx{display:grid;text-align:left}
.fognin{font-size:.75rem}
.fognin:not(:last-child){margin-bottom:1.5rem}
.kOJa-dB{display:block;font-size:.625rem;color:#fff}
.lopKUj{position:absolute;top:calc(-1.5 * (0 + 3rem))}
/*.cYtdTH{margin:1.313rem 0 1rem}*/
/*.gefSol{font-weight:100;background-image:linear-gradient(#d62d36,#64321d);padding-bottom:2.25rem}*/
.eSiFpi{padding-top:calc(2.25rem + .375rem)}
/*.kcXwIY{font-size:5rem;text-align:center;font-weight:400;color:#fff}*/
.cVjBCj{display:-webkit-box}
.frgRKG{display:grid}
.bIlJhm{padding-bottom:1.313rem}
.lgbAKX{padding-top:calc(2.25rem + .375rem)}
.kojbqH{font-size:5rem;margin-bottom:1rem;text-align:center}
.jZrfsi{font-size:2.25rem;font-weight:400;line-height:1.1}
.euQZer{margin-top:2.25rem;text-align:center;font-weight:100;color:#000}
.gRiFtA{position:relative;height:480px}
.fOsBvT{position:absolute;top:50%;left:50%;transform:translate(-50%)}
.gTBWpu{text-align:center;padding:0 1rem}
.fHiIPi{margin:1rem 0}
.iXrcWP{z-index:2;bottom:0;display:-webkit-box;padding:1rem;position:fixed;left:0;right:0}
.cziiuX svg{display:block;height:22px}
.fRTMWj svg{display:block;height:19px}
.iuNSEV{display:-webkit-box}
.iuNSEV .SocialLinks__Link-jwyj6b-1+.SocialLinks__Link-jwyj6b-1{margin-left:1.5rem}
.uGviF{font-size:2.25rem;font-weight:100;line-height:1.125;margin-bottom:2.25rem}
.kTXFZQ{display:block;color:inherit;margin:0 .25rem}
.hAxKUd{display:block;color:inherit}
.hAxKUd+.PageFooterHotSongLinks__Link-sc-1adazwo-0:before{content:'•';margin:0 .75rem}
.boDKcJ{background-color:#121212}
.gwrcCS{display:block;color:inherit;font-weight:100;cursor:pointer}
.gUdeqB{display:grid;color:#fff;padding:3rem 60px 2.25rem}
.gUdeqB .PageFooterdesktop__Link-hz1fx1-1+.PageFooterdesktop__Link-hz1fx1-1{margin-top:1rem}
.iDkyVM{display:block;color:#9a9a9a;font-weight:100;font-size:.625rem}
.kNXBDG{display:grid;color:#fff;padding:3rem 60px 2.25rem;border-top:.15rem solid #2a2a2a}
.kNXBDG .PageFooterdesktop__Link-hz1fx1-1+.PageFooterdesktop__Link-hz1fx1-1{margin-top:1rem}
.eIiYRJ{display:-webkit-box}
.hNrwqx{display:-webkit-box}
.bMBKQI{color:inherit}
.bMBKQI:after{content:'•';margin:0 1rem}
.dcpJwP{margin-right:1rem}
.cXvCRB{position:relative}
.bcJzkW{position:absolute;top:calc(-1 * (0 + 0))}
.UKjRP{position:relative}
`,

`a,abbr,acronym,address,applet,article,aside,audio,b,big,blockquote,body,button,canvas,caption,center,cite,code,dd,del,details,dfn,div,dl,dt,em,embed,fieldset,figcaption,figure,footer,form,h1,h2,h3,h4,h5,h6,header,hgroup,html,i,iframe,img,input,ins,kbd,label,legend,li,mark,menu,nav,object,ol,output,p,pre,q,ruby,s,samp,section,small,span,strike,strong,sub,summary,sup,table,tbody,td,tfoot,th,thead,time,tr,tt,u,ul,var,video{margin:0;padding:0;border:0}
h1,h2,h3,h4,h5,h6{font-size:100%;font-weight:inherit}
html{line-height:1;font-size:16px}
li,ol,ul{list-style:none}
table{border-collapse:collapse;border-spacing:0}
caption,td,th{text-align:left;font-weight:400;vertical-align:middle}
blockquote,q{quotes:none}
blockquote:after,blockquote:before,q:after,q:before{content:""}
a img{border:none}
article,aside,details,figcaption,figure,footer,header,hgroup,main,menu,nav,section,summary{display:block}
button{background:unset;box-shadow:unset;border:unset;text-shadow:unset;cursor:pointer}
body{overflow-x:hidden;background-color:#fff;color:#000;font-family:Programme,Arial,sans-serif;line-height:1.45}
img{max-width:100%}
a{color:#7d8fe8;text-decoration:none}
*,:after,:before{box-sizing:border-box}
hr{border:1px solid #e9e9e9;border-width:1px 0 0;margin:1rem 0}
pre{white-space:pre-wrap}
::selection{background-color:#b2d7fe}
.noscroll{overflow:hidden;position:absolute;height:100vh;width:100vw}
.noscroll-fixed{overflow:hidden;position:fixed;width:100%}
.grecaptcha-badge{visibility:hidden}
#cf_alert_div{display:none}
`
    ]

    html = html
      .replace('<style id="REPX1"></style>', () => {
        return `<style>${defaultCSSTexts[0]}</style>` // font-face
      }).replace('<style id="REPX2"></style>', () => {
        return `<style>${defaultCSSTexts[1]}\n${defaultCSSTexts[2]}</style>`
      }).replace(/<svg([^><]+)><svg-repx(\d+) v1 \/><\/svg>/g, (a, w, d) => {
        d = +d
        if (d >= 0) {
          let text = defaultSVGBoxs[d]
          if (typeof text === 'string') {
            return `<svg${w}>` + text.substring(5);
          }
        }
        return ''
      })
    return html

  }

  function contentStyling () {
    // contentStyling is to generate a specific css for the styling matching the main window
    // mainly background-color and text colors

    // only if genius.style.enable is set to true by external script
    if (genius.style.enabled !== true) return null
    if (typeof genius.style.setup === 'function') {
      if (genius.style.setup() === false) return null
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
    `
    return css
  }

  function contentStylingIframe (html, contentStyle) {
    if (!contentStyle) return html
    let css = `
    body {
      background-color: var(--egl-background);
      color: var(--egl-color);
      font-size: var(--egl-font-size);
      margin: 0;
      padding: 0;
      padding-top: 80vh;
      /* this is intended to give some space to see the first line at the vertical center */
      padding-bottom: 50vh;
      /* this is intended to give some space to see the last line at the vertical center */
    }
    
    main,
    #application {
      --egl-container-display: none;
      /* default hide; override by info conatiner */
    }
    
    #application {
      padding: 28px;
      /* looks better to give some space away from the iframe */
    }
    
    div[data-lyrics-container] {
      font-size: var(--egl-font-size);
      /* adjust font to smaller size */
    }
    
    div[class*="SongPageGrid"],
    div[class*="SongHeader"] {
      background-color: transparent;
      padding: 0;
      color: var(--egl-color);
    }
    
    div[class*="SongPageGrid"],
    div[class*="SongHeaderWithPrimis__Container"] {
      background-image: none;
      /* no header background image */
    }
    
    div[data-exclude-from-selection] {
      display: none;
    }
    
    main[class*="Container"] a[href] {
      color: var(--egl-color) !important;
    }
    
    main[class*="Container"] h1[font-size][class] {
      color: var(--egl-color);
    }
    
    main[class*="Container"] h1[font-size][class*="SongHeaderWithPrimis__Title"] {
      margin-bottom: 8px;
    }
    
    div[class*="MetadataStats__Container"] {
      display: block;
      /* not flexbox */
      width: 100%;
    }
    
    div[class*="SongHeaderWithPrimis__Left"] {
      display: none;
      /* just empty space */
    }
    
    div[class*="SongPageGriddesktop"] {
      display: block;
    }
    
    span[class*="LabelWithIcon"]>svg,
    button[class*="LabelWithIcon"]>svg,
    div[class*="Tooltip__Container"] svg,
    span[class*="InlineSvg__Wrapper"]>svg {
      fill: currentColor;
      /* dynamic color instead of black */
    }
    
    p[class*="__Label"],
    span[class*="__Label"],
    div[class*="__Section"],
    button[class*="__Container"] {
      color: inherit;
      /* follow parent styles */
      text-decoration: none;
      cursor: inherit;
      /* follow parent styles */
    }
    
    div[class*="MetadataStats"] {
      cursor: default;
      /* no pointer */
    }
    
    div[class*="SongHeaderWithPrimis__Information"] div[class*="HeaderCreditsPrimis__Container"] {
      /* using flexbox with wrapping */
      display: flex;
      flex-direction: row;
      flex-wrap: wrap;
      gap: 0px;
      align-items: center;
      justify-items: center;
    }
    
    div[class*="SongHeaderWithPrimis__Information"] {
      margin: 0;
      padding: 0;
      max-width: 100%;
      white-space: normal;
      display: flex;
      flex-direction: column;
    }
    
    div[class*="SongHeaderWithPrimis__Bottom"] a[href] {
      padding: 0;
      margin: 0;
    }
    
    div[class*="SongHeaderWithPrimis__Right"] {
      background-color: var(--egl-infobox-background);
      /* give some color to info container background */
      padding: 18px 26px;
      /* looks better */
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
      background-color: transparent;
      outline: none;
    }
    
    body .annotated span:hover,
    body .annotated a[href]:hover,
    body .annotated a[href]:focus-visible,
    body .annotated:hover span,
    body .annotated.highlighted span {
      text-decoration: underline;
    }
    
    a[href][class],
    span[class*="PortalTooltip"],
    div[class*="HeaderCreditsPrimis"],
    div[class*="HeaderArtistAndTracklistPrimis"] {
      font-size: inherit;
    }
    
    div[class*="SongHeaderWithPrimis__Information"] h1+div[class*="HeaderArtistAndTracklistPrimis"] {
      font-size: 80%;
      margin-top: 10px;
      margin-bottom: 3px;
    }
    
    div[class*="MetadataStats__Stats"] {
      /* using flexbox with wrapping */
      display: flex;
      flex-wrap: wrap;
      /* element blocks with wrapping */
      white-space: nowrap;
      /* text itself no wrapping */
      row-gap: 4px;
      column-gap: 16px;
      margin-top: 6px;
      width: 100%;
      /* force the div to be full width */
    }
    
    h1,
    div[class*="SongPage__LyricsWrapper"] {
      white-space: normal;
    }
    
    div[class*="MetadataStats__Stats"]>[class] {
      margin-right: 0;
      display: flex;
      justify-content: center;
      align-items: center;
      column-gap: 2px;
    }
    
    div[class*="SongHeaderWithPrimis__Information"] div[class*="HeaderCreditsPrimis__List"] {
      font-size: 85%;
    }
    
    div[class*="SongHeaderWithPrimis__Information"]~div[class*="SongHeaderWithPrimis__PrimisContainer"] {
      display: none;
    }
    
    div[class*="SongHeaderWithPrimis__Information"] {
      --egl-container-display: '-NULL-';
      /* all under info would not hide */
    }
    
    div[class*="Footer"],
    div[class*="Leaderboard"] {
      display: none;
      /* unnessary info */
    }
    
    div[class*="SongPage__Section"] #about,
    div[class*="SongPage__Section"] #about~*,
    div[class*="SongPage__Section"] #comments,
    div[class*="SongPage__Section"] #comments~* {
      display: none;
      /* unnessary info */
    }
    
    div[class*="SongPage__Section"] #lyrics-root-pin-spacer {
      padding-top: 12px;
      /* look better */
    }
    
    div[class*="Header"] {
      max-width: unset;
      /* default just 50%; want full width */
    }
    
    div[class*="SongHeader"] h1[font-size="medium"] {
      font-size: 140%;
      /* make song header title smaller */
      white-space: break-spaces;
    }
    
    div[class*="SongHeader"] h1[font-size="xSmallHeadline"] {
      font-size: 120%;
      /* make song header title bigger */
      white-space: break-spaces;
    }
    
    /* the following shall apply with padding-top: 80vh */
    /* the content might be hidden if height > 80vh */
    /* the max-height allow the header box to be scrolled if height > 80vh */
    .genius-lyrics-header-container {
      position: relative;
      /* set 100% width for inner absolute box */
    }
    
    .genius-lyrics-header-container>* {
      /* main purpose for adding class using CSS event triggering; avoid :has() */
      --genius-lyrics-header-content-display: none;
      display: var(--genius-lyrics-header-content-display);
      /* none by default */
    }
    
    .genius-lyrics-header-container>.genius-lyrics-header-content {
      --genius-lyrics-header-content-display: '--NULL--';
      /* override none */
      position: absolute;
      width: 100%;
      /* related to .genius-lyrics-header-container which is padded */
      transform: translateY(-100%);
      /* 100% height refer to the element itself dim */
      max-height: 80vh;
    }
    
    div[class*="SongHeaderWithPrimis__Container"]>div[class*="SongHeaderWithPrimis__Right"].genius-lyrics-header-content {
      display: flex;
      flex-direction: column;
    }
    
    div[class*="SongHeaderWithPrimis__Container"]>div[class*="SongHeaderWithPrimis__Right"].genius-lyrics-header-content>div {
      overflow: auto;
    }
    
    div[class*="Lyrics__Container"][data-lyrics-container="true"] {
      word-break: keep-all;
      /* not only a single lyrics character get wrapped. the whole lyrics word will be wrapped */
    }
    
    div[class*="HeaderCreditsPrimis__Section"] {
      /* flexbox for header info */
      display: flex;
      flex-direction: row;
      flex-wrap: wrap;
      column-gap: 18px;
      row-gap: 2px;
      width: 100%;
      justify-content: start;
      padding: 4px 0px;
    }
    
    div[class*="LyricsEditdesktop__"] {
      display: none;
    }
    
    div[class*="HeaderArtistAndTracklistPrimis__Container"] {
      flex-wrap: wrap;
      column-gap: 6px;
      row-gap: 2p;
      x
    }
    
    div[class*="HeaderArtistAndTracklistPrimis__Container"] div[class*="HeaderArtistAndTracklistPrimis__Tracklist"]>a[href] {
      margin: 6px;
    }
    
    body button {
      color: inherit;
    }
    
    div[class*="SongHeaderWithPrimis__Information"] div[class*="SongHeaderWithPrimis__Bottom"] {
      display: flex;
      flex-direction: column;
    }
    
    div[class*="SongHeaderWithPrimis__Information"] div[class*="SongHeaderWithPrimis__Bottom"] a[href="#about"] {
      font-weight: 300;
      font-size: 85%;
      opacity: 0.65;
      /* coloring only */
    }
    
    button[class*="LabelWithIcon__Container"] {
      display: flex;
      justify-content: center;
      cursor: default;
    }
    
    body #annotationcontainer958 {
      font-size: var(--egl-font-size);
    }
    
    .annotationcontent {
      max-height: 30vh;
      overflow: auto;
    }
    
    [class*="SongHeaderWithPrimis"] a[href][class*="Link__"] {
      --egl-color: var(--egl-link-color);
    }
    
    [class*="HeaderCreditsPrimis__List"] {
      justify-content: center;
      align-items: center;
      display: inline-flex;
      flex-direction: row;
      column-gap: 6px;
    }
    `

    const headhtml = `<style>${contentStyle}\n${css}</style>`

    // Add to <head>
    html = appendHeadText(html, headhtml)
    return html
  }

  let isShowLyricsInterrupted = false
  function interuptMessageHandler (ev) {
    const data = (ev || 0).data || 0
    if (data.iAm === custom.scriptName && data.type === 'lyricsDisplayState' && typeof data.visibility === 'string') {
      isShowLyricsInterrupted = data.visibility !== 'loading'
    }
  }

  // to check validity of the content style being used in defaultCSS
  const defaultStyleCheckerArr = [ ".dTXQYT", ".ilfajN", ".bIwkeM", ".dIgauN", ".jOhzET", ".kokouQ", ".xQwqG", ".jDxAhO", ".dawSPu", ".cmIqeW", ".hTPksM", ".hVAZmF", ".cLBJdA", ".cpvLYi", ".kMDkxm", ".leLkHK", ".cRrFdP", ".dvOJud", ".fqAixv", ".cVGQZE", ".eRbhLo", ".huhsMa", ".dCKKNS", ".kMItKF", ".gjSNHg", ".itbKya", ".eMjKRh", ".eQViPi", ".ctylSH", ".gAieh", ".csMTdh", ".jecoie", ".jiZgac", ".brVVKA", ".iMmhUH", ".iFxQsP", ".hudniQ", ".dnpvgJ", ".jSgIpQ", ".fmRrc", ".iEXgTT", ".heddkF", ".ENCiS", ".iwZJzz", ".bBMTMQ", ".dyewdM", ".ePvBqA", ".kJxpEi", ".ueUKD", ".fraZOY", ".kMKmmz", ".hQgDBO", ".fUyrrM", ".fVWWod", ".lfAvEQ", ".fdEmdh", ".fHdUT", ".jrjShc", ".YYrds", ".fMoZxb", ".hXQMRu", ".eDBQeK", ".rncXA", ".kkpCaw", ".eqRvkr", ".bcLwQh", ".hFPGxa", ".lbdVJq", ".hGLtDM", ".bXbziL", ".ldjaSd", ".cSKAwQ", ".fPpEQG", ".vrxkS", ".cabqMy", ".fyUjsz", ".esoPOn", ".uEMeZ", ".ceKRFE", ".bZsZHM", ".iRKrFW", ".dWcYSx", ".fognin", ".lopKUj", ".eSiFpi", ".cVjBCj", ".frgRKG", ".bIlJhm", ".lgbAKX", ".kojbqH", ".jZrfsi", ".euQZer", ".gRiFtA", ".fOsBvT", ".gTBWpu", ".fHiIPi", ".iXrcWP", ".cziiuX", ".fRTMWj", ".iuNSEV", ".uGviF", ".kTXFZQ", ".hAxKUd", ".boDKcJ", ".gwrcCS", ".gUdeqB", ".iDkyVM", ".kNXBDG", ".eIiYRJ", ".hNrwqx", ".bMBKQI", ".dcpJwP", ".cXvCRB", ".bcJzkW", ".UKjRP", ".noscroll"];
  // store all the svgs displayed in the lyrics panel; reduce cache size
  const defaultSVGBoxs =
    [
      "<svg><path d=\"M11.7 2.9s0-.1 0 0c-.8-.8-1.7-1.2-2.8-1.2-1.1 0-2.1.4-2.8 1.1-.2.2-.3.4-.5.6v.1c0 .1.1.1.1.1.4-.2.9-.3 1.4-.3 1.1 0 2.2.5 2.9 1.2h1.6c.1 0 .1-.1.1-.1V2.9c.1 0 0 0 0 0zm-.1 4.6h-1.5c-.8 0-1.4-.6-1.5-1.4.1 0 0-.1 0-.1-.3 0-.6.2-.8.4v.2c-.6 1.8.1 2.4.9 2.4h1.1c.1 0 .1.1.1.1v.4c0 .1.1.1.1.1.6-.1 1.2-.4 1.7-.8V7.6c.1 0 0-.1-.1-.1z\"></path><path d=\"M11.6 11.9s-.1 0 0 0c-.1 0-.1 0 0 0-.1 0-.1 0 0 0-.8.3-1.6.5-2.5.5-3.7 0-6.8-3-6.8-6.8 0-.9.2-1.7.5-2.5 0-.1-.1-.1-.2-.1h-.1C1.4 4.2.8 5.7.8 7.5c0 3.6 2.9 6.4 6.4 6.4 1.7 0 3.3-.7 4.4-1.8V12c.1 0 0-.1 0-.1zm13.7-3.1h3.5c.8 0 1.4-.5 1.4-1.3v-.2c0-.1-.1-.1-.1-.1h-4.8c-.1 0-.1.1-.1.1v1.4c-.1 0 0 .1.1.1zm5.1-6.7h-5.2c-.1 0-.1.1-.1.1v1.4c0 .1.1.1.1.1H29c.8 0 1.4-.5 1.4-1.3v-.2c.1-.1.1-.1 0-.1z\"></path><path d=\"M30.4 12.3h-6.1c-1 0-1.6-.6-1.6-1.6V1c0-.1-.1-.1-.1-.1-1.1 0-1.8.7-1.8 1.8V12c0 1.1.7 1.8 1.8 1.8H29c.8 0 1.4-.6 1.4-1.3v-.1c.1 0 .1-.1 0-.1zm12 0c-.6-.1-.9-.6-.9-1.3V1.1s0-.1-.1-.1H41c-.9 0-1.5.6-1.5 1.5v9.9c0 .9.6 1.5 1.5 1.5.8 0 1.4-.6 1.5-1.5 0-.1 0-.1-.1-.1zm8.2 0h-.2c-.9 0-1.4-.4-1.8-1.1l-4.5-7.4-.1-.1c-.1 0-.1.1-.1.1V8l2.8 4.7c.4.6.9 1.2 2 1.2 1 0 1.7-.5 2-1.4 0-.2-.1-.2-.1-.2zm-.9-3.8c.1 0 .1-.1.1-.1V1.1c0-.1 0-.1-.1-.1h-.4c-.9 0-1.5.6-1.5 1.5v3.1l1.7 2.8c.1 0 .1.1.2.1zm13 3.8c-.6-.1-.9-.6-.9-1.2v-10c0-.1 0-.1-.1-.1h-.3c-.9 0-1.5.6-1.5 1.5v9.9c0 .9.6 1.5 1.5 1.5.8 0 1.4-.6 1.5-1.5l-.2-.1zm18.4-.5H81c-.7.3-1.5.5-2.5.5-1.6 0-2.9-.5-3.7-1.4-.9-1-1.4-2.4-1.4-4.2V1c0-.1 0-.1-.1-.1H73c-.9 0-1.5.6-1.5 1.5V8c0 3.7 2 5.9 5.4 5.9 1.9 0 3.4-.7 4.3-1.9v-.1c0-.1 0-.1-.1-.1z\"></path><path d=\"M81.2.9h-.3c-.9 0-1.5.6-1.5 1.5v5.7c0 .7-.1 1.3-.3 1.8 0 .1.1.1.1.1 1.4-.3 2.1-1.4 2.1-3.3V1c0-.1-.1-.1-.1-.1zm12.7 7.6l1.4.3c1.5.3 1.6.8 1.6 1.2 0 .1.1.1.1.1 1.1-.1 1.8-.7 1.8-1.5s-.6-1.2-1.9-1.5l-1.4-.3c-3.2-.6-3.8-2.3-3.8-3.6 0-.7.2-1.3.6-1.9v-.2c0-.1-.1-.1-.1-.1-1.5.7-2.3 1.9-2.3 3.4-.1 2.3 1.3 3.7 4 4.1zm5.2 3.2c-.1.1-.1.1 0 0-.9.4-1.8.6-2.8.6-1.6 0-3-.5-4.3-1.4-.3-.3-.5-.6-.5-1 0-.1 0-.1-.1-.1s-.3-.1-.4-.1c-.4 0-.8.2-1.1.6-.2.3-.4.7-.3 1.1.1.4.3.7.6 1 1.4 1 2.8 1.5 4.5 1.5 2 0 3.7-.7 4.5-1.9v-.1c0-.1 0-.2-.1-.2z\"></path><path d=\"M94.1 3.2c0 .1.1.1.1.1h.2c1.1 0 1.7.3 2.4.8.3.2.6.3 1 .3s.8-.2 1.1-.6c.2-.3.3-.6.3-.9 0-.1 0-.1-.1-.1-.2 0-.3-.1-.5-.2-.8-.6-1.4-.9-2.6-.9-1.2 0-2 .6-2 1.4.1 0 .1 0 .1.1z\"></path></svg>",
      "<svg><path d=\"M21.48 20.18L14.8 13.5a8.38 8.38 0 1 0-1.43 1.4l6.69 6.69zM2 8.31a6.32 6.32 0 1 1 6.32 6.32A6.32 6.32 0 0 1 2 8.31z\"></path></svg>",
      "<svg><path d=\"M1.6 8.8l.6-.6 1 1 .5.7V6H0v-.8h4.5v4.6l.5-.6 1-1 .6.5L4 11.3 1.6 8.8z\"></path></svg>",
      "<svg><path d=\"M12.917 2.042H10.75V.958H9.667v1.084H5.333V.958H4.25v1.084H2.083C1.487 2.042 1 2.529 1 3.125v10.833c0 .596.488 1.084 1.083 1.084h10.834c.595 0 1.083-.488 1.083-1.084V3.125c0-.596-.488-1.083-1.083-1.083zm0 11.916H2.083V6.375h10.834v7.583zm0-8.666H2.083V3.125H4.25v1.083h1.083V3.125h4.334v1.083h1.083V3.125h2.167v2.167z\" stroke-width=\"0.096\"></path></svg>",
      "<svg><path d=\"M16.27 13.45L12 10.58V4.46H9.76v7.25L15 15.25z\"></path><path d=\"M11 2a9 9 0 1 1-9 9 9 9 0 0 1 9-9m0-2a11 11 0 1 0 11 11A11 11 0 0 0 11 0z\"></path></svg>",
      "<svg><path d=\"M12.55 6.76a4 4 0 1 0 0-4.59 4.41 4.41 0 0 1 0 4.59zm3.07 2.91v5.17H22V9.66l-6.38.01M7 9a4.43 4.43 0 0 0 3.87-2.23 4.41 4.41 0 0 0 0-4.59 4.47 4.47 0 0 0-8.38 2.3A4.48 4.48 0 0 0 7 9zm-7 1.35v6.12h13.89v-6.14l-6.04.01-7.85.01\"></path></svg>",
      "<svg><path d=\"M0 7l6.16-7 3.3 7H6.89S5.5 12.1 5.5 12.17h5.87L6.09 22l.66-7H.88l2.89-8z\"></path></svg>",
      "<svg><path d=\"M6.5037 26.1204a14.0007 14.0007 0 0 0 17.6775-1.7412 13.9997 13.9997 0 0 0 1.7412-17.6775A14.0004 14.0004 0 0 0 11.5505.7487a13.9992 13.9992 0 0 0-7.1682 3.8316 14.0002 14.0002 0 0 0 2.1213 21.54ZM7.615 4.5022a11.9998 11.9998 0 0 1 16.6443 16.6443 12 12 0 0 1-12.3186 5.1028A12.0005 12.0005 0 0 1 3.1951 9.8875 12.0018 12.0018 0 0 1 7.615 4.5022Zm6.6667 1.9775a1.4996 1.4996 0 0 0-1.4711 1.7928 1.5027 1.5027 0 0 0 .7624 1.0293 1.5002 1.5002 0 0 0 2.063-1.9668 1.4997 1.4997 0 0 0-.2937-.4158 1.4992 1.4992 0 0 0-1.0606-.4394Zm1 14v-8h-4v2h2v6h-3v2h8v-2h-3Z\"></path></svg>",
      "<svg><path d=\"M10.66 10.91L0 1.5 1.32 0l9.34 8.24L20 0l1.32 1.5-10.66 9.41\"></path></svg>",
      "<svg><path d=\"M8.09 3.81c-1.4 0-1.58.84-1.58 1.67v1.3h3.35L9.49 11h-3v9H2.33v-9H0V6.88h2.42V3.81C2.42 1.3 3.81 0 6.6 0H10v3.81z\"></path></svg>",
      "<svg><path d=\"M20 1.89l-2.3 2.16v.68a12.28 12.28 0 0 1-3.65 8.92c-5 5.13-13.1 1.76-14.05.81 0 0 3.78.14 5.81-1.76A4.15 4.15 0 0 1 2.3 9.86h2S.81 9.05.81 5.81A11 11 0 0 0 3 6.35S-.14 4.05 1.49.95a11.73 11.73 0 0 0 8.37 4.19A3.69 3.69 0 0 1 13.51 0a3.19 3.19 0 0 1 2.57 1.08 12.53 12.53 0 0 0 3.24-.81l-1.75 1.89A10.46 10.46 0 0 0 20 1.89z\"></path></svg>",
      "<svg><path d=\"M0 7l6.16-7 3.3 7H6.89S5.5 12.1 5.5 12.17h5.87L6.09 22l.66-7H.88l2.89-8z\"></path></svg>",
      "<svg><path d=\"M1.6 8.8l.6-.6 1 1 .5.7V6H0v-.8h4.5v4.6l.5-.6 1-1 .6.5L4 11.3 1.6 8.8z\"></path></svg>",
      "<svg><circle cx=\"74\" cy=\"10\" r=\"9\"></circle></svg>",
      "<svg><path d=\"M8.09 3.81c-1.4 0-1.58.84-1.58 1.67v1.3h3.35L9.49 11h-3v9H2.33v-9H0V6.88h2.42V3.81C2.42 1.3 3.81 0 6.6 0H10v3.81z\"></path></svg>",
      "<svg><path d=\"M20 1.89l-2.3 2.16v.68a12.28 12.28 0 0 1-3.65 8.92c-5 5.13-13.1 1.76-14.05.81 0 0 3.78.14 5.81-1.76A4.15 4.15 0 0 1 2.3 9.86h2S.81 9.05.81 5.81A11 11 0 0 0 3 6.35S-.14 4.05 1.49.95a11.73 11.73 0 0 0 8.37 4.19A3.69 3.69 0 0 1 13.51 0a3.19 3.19 0 0 1 2.57 1.08 12.53 12.53 0 0 0 3.24-.81l-1.75 1.89A10.46 10.46 0 0 0 20 1.89z\"></path></svg>",
      "<svg><path d=\"M10 0c2.724 0 3.062 0 4.125.06.83.017 1.65.175 2.426.467.668.254 1.272.65 1.77 1.162.508.498.902 1.1 1.153 1.768.292.775.45 1.595.467 2.424.06 1.063.06 1.41.06 4.123 0 2.712-.06 3.06-.06 4.123-.017.83-.175 1.648-.467 2.424-.52 1.34-1.58 2.402-2.922 2.92-.776.293-1.596.45-2.425.468-1.063.06-1.41.06-4.125.06-2.714 0-3.062-.06-4.125-.06-.83-.017-1.65-.175-2.426-.467-.668-.254-1.272-.65-1.77-1.162-.508-.498-.902-1.1-1.153-1.768-.292-.775-.45-1.595-.467-2.424C0 13.055 0 12.708 0 9.995c0-2.712 0-3.04.06-4.123.017-.83.175-1.648.467-2.424.25-.667.645-1.27 1.153-1.77.5-.507 1.103-.9 1.77-1.15C4.225.234 5.045.077 5.874.06 6.958 0 7.285 0 10 0zm0 1.798h.01c-2.674 0-2.992.06-4.046.06-.626.02-1.245.15-1.83.377-.434.16-.828.414-1.152.746-.337.31-.602.69-.775 1.113-.222.595-.34 1.224-.348 1.858-.06 1.064-.06 1.372-.06 4.045s.06 2.99.06 4.044c.007.633.125 1.262.347 1.857.17.434.434.824.775 1.142.31.33.692.587 1.113.754.596.222 1.224.34 1.86.348 1.063.06 1.37.06 4.045.06 2.674 0 2.992-.06 4.046-.06.635-.008 1.263-.126 1.86-.348.87-.336 1.56-1.025 1.897-1.897.217-.593.332-1.218.338-1.848.06-1.064.06-1.372.06-4.045s-.06-2.99-.06-4.044c-.01-.623-.128-1.24-.347-1.827-.16-.435-.414-.83-.745-1.152-.318-.34-.71-.605-1.143-.774-.596-.222-1.224-.34-1.86-.348-1.063-.06-1.37-.06-4.045-.06zm0 3.1c1.355 0 2.655.538 3.613 1.496.958.958 1.496 2.257 1.496 3.61 0 2.82-2.288 5.108-5.11 5.108-2.822 0-5.11-2.287-5.11-5.107 0-2.82 2.288-5.107 5.11-5.107zm0 8.415c.878 0 1.72-.348 2.34-.97.62-.62.97-1.46.97-2.338 0-1.827-1.482-3.31-3.31-3.31s-3.31 1.483-3.31 3.31 1.482 3.308 3.31 3.308zm6.51-8.633c0 .658-.533 1.192-1.192 1.192-.66 0-1.193-.534-1.193-1.192 0-.66.534-1.193 1.193-1.193.316 0 .62.126.844.35.223.223.35.526.35.843z\"></path></svg>",
      "<svg><path d=\"M19.81 3A4.32 4.32 0 0 0 19 1a2.86 2.86 0 0 0-2-.8C14.21 0 10 0 10 0S5.8 0 3 .2A2.87 2.87 0 0 0 1 1a4.32 4.32 0 0 0-.8 2S0 4.51 0 6.06V8a30 30 0 0 0 .2 3 4.33 4.33 0 0 0 .8 2 3.39 3.39 0 0 0 2.2.85c1.46.14 5.9.19 6.68.2h.4c1 0 4.35 0 6.72-.21a2.87 2.87 0 0 0 2-.84 4.32 4.32 0 0 0 .8-2 30.31 30.31 0 0 0 .2-3.21V6.28A30.31 30.31 0 0 0 19.81 3zM7.94 9.63V4l5.41 2.82z\"></path></svg>",
      "<svg><path d=\"M0 10h24v4h-24z\"></path></svg>",
      "<svg><path d=\"M6.5037 26.1204a14.0007 14.0007 0 0 0 17.6775-1.7412 13.9997 13.9997 0 0 0 1.7412-17.6775A14.0004 14.0004 0 0 0 11.5505.7487a13.9992 13.9992 0 0 0-7.1682 3.8316 14.0002 14.0002 0 0 0 2.1213 21.54ZM7.615 4.5022a11.9998 11.9998 0 0 1 16.6443 16.6443 12 12 0 0 1-12.3186 5.1028A12.0005 12.0005 0 0 1 3.1951 9.8875 12.0018 12.0018 0 0 1 7.615 4.5022Zm6.6667 1.9775a1.4996 1.4996 0 0 0-1.4711 1.7928 1.5027 1.5027 0 0 0 .7624 1.0293 1.5002 1.5002 0 0 0 2.063-1.9668 1.4997 1.4997 0 0 0-.2937-.4158 1.4992 1.4992 0 0 0-1.0606-.4394Zm1 14v-8h-4v2h2v6h-3v2h8v-2h-3Z\"></path></svg>",
      "<svg><path d=\"m11 4.12 7.6 13.68H3.4L11 4.12M11 0 0 19.8h22L11 0z\"></path><path d=\"M10 8.64h2v4.51h-2zm1 5.45a1.13 1.13 0 0 1 1.13 1.15A1.13 1.13 0 1 1 11 14.09z\"></path></svg>",
      "<svg><path d=\"M16.52 21.29H6V8.5l.84-.13a3.45 3.45 0 0 0 1.82-1.09 13.16 13.16 0 0 0 .82-1.85c1.06-2.69 2-4.78 3.52-5.31a2.06 2.06 0 0 1 1.74.17c2.5 1.42 1 5 .16 6.95-.11.27-.25.6-.31.77a.78.78 0 0 0 .6.36h4.1a2.29 2.29 0 0 1 2.37 2.37c0 .82-1.59 5.4-2.92 9.09a2.39 2.39 0 0 1-2.22 1.46zm-8.52-2h8.56a.48.48 0 0 0 .31-.17c1.31-3.65 2.73-7.82 2.79-8.44 0-.22-.1-.32-.37-.32h-4.1A2.61 2.61 0 0 1 12.54 8 4.29 4.29 0 0 1 13 6.46c.45-1.06 1.64-3.89.7-4.43-.52 0-1.3 1.4-2.38 4.14a10 10 0 0 1-1.13 2.38A5.28 5.28 0 0 1 8 10.11zM0 8.4h4.86v12.96H0z\"></path></svg>",
      "<svg><path d=\"M8 21.36a2.12 2.12 0 0 1-1.06-.29c-2.5-1.42-1-5-.16-6.95.11-.27.25-.6.31-.77a.78.78 0 0 0-.6-.36H2.37A2.29 2.29 0 0 1 0 10.64c0-.82 1.59-5.4 2.92-9.09A2.39 2.39 0 0 1 5.1.07h10.56v12.79l-.84.13A3.45 3.45 0 0 0 13 14.08a13.16 13.16 0 0 0-.82 1.85c-1.06 2.69-2 4.79-3.49 5.31a2.06 2.06 0 0 1-.69.12zM5.1 2.07a.48.48 0 0 0-.31.17C3.48 5.89 2.07 10.06 2 10.68c0 .22.1.32.37.32h4.1a2.61 2.61 0 0 1 2.61 2.4 4.29 4.29 0 0 1-.48 1.51c-.46 1.09-1.65 3.89-.7 4.42.52 0 1.3-1.4 2.38-4.14a10 10 0 0 1 1.13-2.38 5.27 5.27 0 0 1 2.25-1.56V2.07zM16.76 0h4.86v12.96h-4.86z\"></path></svg>",
      "<svg><path d=\"M19.29 1.91v11.46H7.69l-.57.7L5 16.64v-3.27H1.91V1.91h17.38M21.2 0H0v15.28h3.12V22l5.48-6.72h12.6V0z\"></path><path d=\"M4.14 4.29h12.93V6.2H4.14zm0 4.09h12.93v1.91H4.14z\"></path></svg>",
      "<svg><path d=\"M16.03 7.39v12.7H1.91V7.39H0V22h17.94V7.39h-1.91\"></path><path d=\"M8.08 3.7v11.81h1.91V3.63l2.99 2.98 1.35-1.35L9.07 0 3.61 5.46l1.36 1.35L8.08 3.7\"></path></svg>",
      "<svg><path d=\"M11 2c4 0 7.26 3.85 8.6 5.72-1.34 1.87-4.6 5.73-8.6 5.73S3.74 9.61 2.4 7.73C3.74 5.86 7 2 11 2m0-2C4.45 0 0 7.73 0 7.73s4.45 7.73 11 7.73 11-7.73 11-7.73S17.55 0 11 0z\"></path><path d=\"M11 5a2.73 2.73 0 1 1-2.73 2.73A2.73 2.73 0 0 1 11 5m0-2a4.73 4.73 0 1 0 4.73 4.73A4.73 4.73 0 0 0 11 3z\"></path></svg>",
      "<svg><path d=\"M24 10h-10v-10h-4v10h-10v4h10v10h4v-10h10z\"></path></svg>",
  ]

  async function trimHTMLReponseTextFn(htmlText) {
    /*

    original:                                         200 ~ 400 KB
    trimHTMLReponseText only:                         130 ~ 200 KB [Spotify Genius Lyrics]
    trimHTMLReponseText + enableStyleSubstitution:    25 ~ 50 KB [YouTube Genius Lyrics Simplified Iframe Content]

    */

    const originalHtmlText = htmlText

    //unicode fix
    htmlText = htmlText.replace(/[\t\x20\u0009-\u000D\u0085\u00A0\u1680\u2000-\u200A\u2028-\u2029\u202F\u205F\u3000]+/g, ' ') /* spacing */ // eslint-disable-line no-control-regex
    htmlText = htmlText.replace(/[\u180E\u200B-\u200D\u2060\uFEFF]/g, '')

    // reduce blank lines
    htmlText = htmlText.replace(/[\r\n](\x20*[\r\n])+/g, '\n')

    // remove metas
    htmlText = htmlText.replace(/\s*<meta\b[^<>]*(?:(?!>)<[^<>]*)*>\s*/gi, (m) => {
      if (m.indexOf('og:url') > 0) return m
      return ''
    })

    // minimize style
    htmlText = htmlText.replace(/\s*<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>\s*/gi, (m) => {
      m = m.replace(/\/\*[^\/\*]*\*\//g, '') // comments

      if (genius.option.enableStyleSubstitution) {
        m = m.replace(/\s[\w\-\.\[\]\=\"]+\{content:\"[^\"]*\"\}\s*/g, ' ') // content:'xxx'
        m = m.replace(/\s+\!important\;/g, ';') // !important
        // this allows further reduction of html text size, but it shall be used with content styling
        // since some genius css is removed in the minimized version (default CSS)

        if (m.indexOf('@font-face') > 0 && m.split('@font-face { font-family: \'Programme\'; ').length === 6) {
          // font-face
          console.log('Genius Lyrics - REPX1')
          return '<style id="REPX1"></style>'
        } else if (m.indexOf('<style data-styled=\"true\" data-styled-version=\"5.1.0\">') >= 0) {
          const arr = defaultStyleCheckerArr
          let match = true
          const p = []
          for (const t of arr) {
            if (m.indexOf(t) < 0) {
              p.push(t)
              match = false
              //break
            }
          }
          if (match) {
            console.log('Genius Lyrics - REPX2 success')
            return '<style id="REPX2"></style>'
          } else {
            console.log('Genius Lyrics - REPX2 failed', p.length, p)
          }
        }
      }

      return m
    })

    // remove all content scripts
    htmlText = htmlText.replace(/\s*<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>\s*/gi, (m) => {
      if (m.indexOf('script src=') > 0) return m
      return ''
    })

    // <link ... />
    htmlText = htmlText.replace(/\s*<link\b[^<>]*(?:(?!>)<[^<>]*)*>\s*/gi, (m) => {
      return ''
    })
    // <noscript>....</noscript>
    htmlText = htmlText.replace(/\s*<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>\s*/gi, (m) => {
      return ''
    })
    // comments tag
    htmlText = htmlText.replace(/\s*\<\!\-\-[^\-\>]+\-\-\>\s*/gi, (m) => {
      return ''
    })
    const om = new Set()
    htmlText = htmlText.replace(/\s*<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>\s*/gi, (m) => {
      let mi = m.indexOf('><') // <svg .... ><....  </svg>
      if (mi < 0) return m
      let n = `<svg><${m.substring(mi + 2).trim()}`
      let match = defaultSVGBoxs.indexOf(n); // array search
      if (match >= 0) {
        return `${m.substring(0, mi)}><svg-repx${match} v1 /></svg>`
      } else {
        om.add(n)
      }
    })
    if (om.size > 0) {
      console.log('Genius Lyrics - new SVGs are found', om.size, [...om.keys()])
    }
    // remove all <div style="display: none;"> ... </div>
    htmlText = htmlText.replace(/<div\b[^<]*(?:(?!<\/div>)<[^<]*)*<\/div>\s*/gi, (m) => {
      if (m.startsWith('<div style="display: none;">')) return ''
      return m
    })

    console.log(`Genius Lyrics - HTML text size reduced from ${metricPrefix(originalHtmlText.length, 2, 1024)} to ${metricPrefix(htmlText.length, 2, 1024)}`)
    // console.log([htmlText])
    // htmlText = response.responseText

    return htmlText
  }

  function defaultSpinnerDOM (container, bar, iframe) {
    const spinnerDOM = {
      createSpinnerHolder: () => {
        const spinnerHolder = document.createElement('div')
        spinnerHolder.classList.add('loadingspinnerholder')
        spinnerDOM.spinnerHolder = spinnerHolder
      },
      createSpinner: () => {
        let spinner = null
        const spinnerHolder = spinnerDOM.spinnerHolder
        if ('createSpinner' in custom) {
          spinner = custom.createSpinner(spinnerHolder)
        } else {
          spinnerHolder.style.left = (iframe.getBoundingClientRect().left + container.clientWidth / 2) + 'px'
          spinnerHolder.style.top = '100px'
          spinner = document.createElement('div')
          spinner.classList.add('loadingspinner')
          spinnerHolder.appendChild(spinner)
        }
        spinnerDOM.spinner = spinner
      },
      displaySpinnerHolder: () => {
        document.body.appendChild(spinnerDOM.spinnerHolder)
      },
      setStatusTitle: (title) => {
        const spinnerHolder = spinnerDOM.spinnerHolder
        spinnerHolder.title = title
      },
      setSpinnerNum: (text) => {
        const spinner = spinnerDOM.spinner
        spinner.textContent = text
      },
      remove: () => {
        const spinnerHolder = spinnerDOM.spinnerHolder
        spinnerHolder.remove()
      }
    }
    return spinnerDOM
  }

  function showLyrics (songInfo, searchresultsLengths) {

    const currentFunctionClosureIdentifier = ((window.showLyricsIdentifier || 0) + 1) % 100000000
    window.showLyricsIdentifier = currentFunctionClosureIdentifier // if this function closure is no longer valid, they will be not equal.
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
    
    let spinnerDOM = null
    if ('customSpinnerDOM' in custom && typeof custom.customSpinnerDOM === 'function') {
      spinnerDOM = custom.customSpinnerDOM(container, bar, iframe)
      if (!spinnerDOM || typeof spinnerDOM !== 'object') spinnerDOM = null
    }
    if (spinnerDOM === null) {
      spinnerDOM = defaultSpinnerDOM(container, bar, iframe)
    }

    spinnerDOM.createSpinnerHolder()
    spinnerDOM.createSpinner()
    spinnerDOM.displaySpinnerHolder()
    // container.appendChild(spinnerHolder)

    function spinnerUpdate (text, title, status, textStatus) {
      if (typeof text === 'string') spinnerDOM.setSpinnerNum(text)
      if (typeof title === 'string') spinnerDOM.setStatusTitle(title)
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

    let isCancelLoadingEnabled = true
    addOneMessageListener('cancelLoading', () => {
      if (window.showLyricsIdentifier !== currentFunctionClosureIdentifier) return
      if (isCancelLoadingEnabled === false) return
      // such as user clicking back btn
      isShowLyricsInterrupted = true
      unScroll()
      try {
        spinnerDOM.remove()
      } catch (e) {
        // could be already removed
      }
      isCancelLoadingEnabled = false
    })

    function isThisShowLyricsInvalidated() {
      return isShowLyricsInterrupted === true || window.showLyricsIdentifier !== currentFunctionClosureIdentifier
    }

    spinnerUpdate('5', 'Downloading lyrics...', 0, 'start')
    unScroll()
    window.postMessage({ iAm: custom.scriptName, type: 'lyricsDisplayState', visibility: 'loading', song: songInfo, searchresultsLengths }, '*')

    function interuptedByExternal () {
      window.removeEventListener('message', interuptMessageHandler, false)
    }

    async function showLyricsRunner () {
      try {
        if (isThisShowLyricsInvalidated()) return interuptedByExternal()
        let cacheReqResult = null
        let html = await new Promise(resolve => loadGeniusSong(songInfo, function loadGeniusSongCb (response, cacheResult) {
          cacheReqResult = cacheResult // not immediately cache this html; cache the proceeded html only
          resolve(response.responseText)
        }))
        if (isThisShowLyricsInvalidated()) return interuptedByExternal()

        if (cacheReqResult !== null) {
          if (genius.option.trimHTMLReponseText === true) {
            html = await trimHTMLReponseTextFn(html)
            if (isThisShowLyricsInvalidated()) return interuptedByExternal()
          }
          // not obtained from cache
          spinnerUpdate('4', 'Downloading annotations...', 100, 'donwloading')
          let annotations = await new Promise(resolve => loadGeniusAnnotations(songInfo, html, annotationsEnabled, function loadGeniusAnnotationsCb (annotations) {
            resolve(annotations)
          }))
          if (isThisShowLyricsInvalidated()) return interuptedByExternal()
          spinnerUpdate('3', 'Composing page...', 200, 'pageComposing')
          html = await new Promise(resolve => combineGeniusResources(songInfo, html, annotations, function combineGeniusResourcesCb (html) {
            // in fact `combineGeniusResources` is synchronous
            resolve(html)
          }))
          if (isThisShowLyricsInvalidated()) return interuptedByExternal()
          annotations = null
          // cache the html text with annotations
          // note: 1 page consume 2XX KB
          // if trimHTMLReponseText is used, trim to 25KB ~ 50KB
          if (genius.option.cacheHTMLRequest === true) cacheReqResult({ responseText: html })
        }
        const contentStyle = contentStyling() || '' // obtained from the main window, to be passed to iframe

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
          try {
            spinnerDOM.remove()
          } catch (e) {
            // could be already removed
          }
          isCancelLoadingEnabled = false
        }

        // event listeners
        addOneMessageListener('genius-iframe-waiting', function () {
          if (window.showLyricsIdentifier !== currentFunctionClosureIdentifier) return
          if (iv === 0) {
            return
          }
          ivf() // this is much faster than 1500ms
          clearInterval(iv)
          iv = 0
        })
        addOneMessageListener('htmlwritten', function () {
          if (window.showLyricsIdentifier !== currentFunctionClosureIdentifier) return
          if (iv > 0) {
            clearInterval(iv)
            iv = 0
          }
          spinnerUpdate('1', 'Calculating...', 302, 'htmlwritten')
        })
        addOneMessageListener('pageready', function (ev) {
          if (window.showLyricsIdentifier !== currentFunctionClosureIdentifier) return
          // note: this is not called after the whole page is rendered
          // console.log(ev.data)
          clear() // loaded
          spinnerUpdate(null, null, 901, 'complete')
          window.postMessage({ iAm: custom.scriptName, type: 'lyricsDisplayState', visibility: 'loaded', lyricsSuccess: true }, '*')
        })
        addOneMessageListener('iframeContentRendered', function (ev) {
          if (window.showLyricsIdentifier !== currentFunctionClosureIdentifier) return
          unScroll()
          window.isPageAbleForAutoScroll = true
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
          unScroll()
          window.postMessage({ iAm: custom.scriptName, type: 'lyricsDisplayState', visibility: 'loaded', lyricsSuccess: false }, '*')
          if (!loadingFailed) {
            console.debug('try again fresh')
            loadingFailed = true
            hideLyricsWithMessage()
            setTimeout(function () {
              custom.addLyrics(true) // new function closure
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
          if (window.showLyricsIdentifier !== currentFunctionClosureIdentifier) return
          if (iv === 0) {
            return
          }
          if (isShowLyricsInterrupted === true) {
            // this is possible if the lyrics was hidden by other function calling
            unableToProcess('Genius Lyrics - showLyrics() was interrupted')
          }
          spinnerUpdate('2', 'Rendering...', 301, 'pageRendering')
          if (iframe.contentWindow && iframe.contentWindow.postMessage) {
            iframe.contentWindow.postMessage({ iAm: custom.scriptName, type: 'writehtml', html, contentStyle, themeKey: genius.option.themeKey }, '*')
          } else if (iframe.closest('html, body') === null) {
            // unlikely as interupter_lyricsDisplayState is checked
            unableToProcess('iframe#lyricsiframe was removed from the page. No contentWindow could be found.')
          } else {
            // console.debug('iframe.contentWindow is ', iframe.contentWindow)
          }
        }
        iv = setInterval(ivf, 1500)
      } catch (e) {
        console.warn(e)
      }
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
    return autoScrollEnabled && ('scrollLyrics' in theme) // note: if iframe is not ready, still no action
  }

  function isScrollLyricsCallable () {
    return autoScrollEnabled && ('scrollLyrics' in theme) && window.isPageAbleForAutoScroll === true // note: if iframe is not ready, still no action
  }

  function scrollLyrics (positionFraction) {
    if (isScrollLyricsCallable() === false) {
      return
    }
    // Relay the event to the iframe
    const iframe = document.getElementById('lyricsiframe')
    const contentWindow = (iframe || 0).contentWindow
    if (contentWindow && typeof contentWindow.postMessage === 'function') {
      contentWindow.postMessage({ iAm: custom.scriptName, type: 'scrollLyrics', position: positionFraction }, '*')
    }
  }

  function searchByQuery (query, container, callback) {
    geniusSearch(query, function geniusSearchCb (r) {
      const hits = r.response.sections[0].hits
      if (hits.length === 0) {
        if (typeof callback === 'function') {
          callback({ hits, status: 200 })
        } else {
          window.alert(custom.scriptName + '\n\nNo search results')
        }
      } else {
        if (typeof callback === 'function') {
          callback({ hits, status: 200 })
        } else {
          custom.listSongs(hits, container, query)
        }
      }
    }, function geniusSearchErrorCb () {
      if (typeof callback === 'function') {
        callback({ status: 500 })
      }
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

  function listenToMessagesHandler (e) {
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
  }

  function listenToMessages () {
    window.addEventListener('message', listenToMessagesHandler, false)
  }

  function unlistenToMessages () {
    window.removeEventListener('message', listenToMessagesHandler, false)
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
    window.addEventListener('message', function (ev) {
      const data = (ev || 0).data || 0
      if (data.iAm === custom.scriptName && data.type === 'togglelyrics') {
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
      let msgFn = function (ev) {
        const data = (ev || 0).data || 0
        if (data.iAm === custom.scriptName && data.type === 'writehtml') {
          window.removeEventListener('message', msgFn, false)
          msgFn = null
          const { data, source } = ev
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

    let html = e.data.html
    html = defaultCSS(html)
    let contentStyle = e.data.contentStyle
    if (typeof contentStyle == 'string' && contentStyle.length > 0) {
      html = contentStylingIframe(html, contentStyle)
    }
    document.documentElement.innerHTML = html

    const communicationWindow = e.source // top
    communicationWindow.postMessage({ iAm: custom.scriptName, type: 'htmlwritten' }, '*')

    // clean up
    e = null

    function addClassNameToInfoHeader (evTarget) {
      const elm = (evTarget || 0)
      const pElm = (elm.parentNode || 0)
      if (elm && pElm && pElm.matches('div[class*="SongHeaderWithPrimis__Container"]') && elm.matches('div[class*="SongHeaderWithPrimis__Right"]')) {
        // let elms = [...pElm.childNodes].filter(entry => entry !== elm)
        // removeElements(elms)
        pElm.classList.add('genius-lyrics-header-container')
        elm.classList.add('genius-lyrics-header-content')
      }
    }

    function cssTriggeringHook (resolve) {
      document.addEventListener('animationstart', (ev) => {
        const evTarget = ev.target
        if (ev.animationName === 'appDomAppended' || ev.animationName === 'appDomAppended2') {
          resolve()
          Promise.resolve(0).then(() => {
            communicationWindow.postMessage({ iAm: custom.scriptName, type: 'iframeLyricsAppRendered' }, '*') // iframeWin -> iframeWin
          })
          if (ev.animationName === 'appDomAppended') {
            evTarget.classList.add('app11')
          }
        }
        if (ev.animationName === 'songHeaderDomAppended') {
          Promise.resolve(0).then(() => {
            communicationWindow.postMessage({ iAm: custom.scriptName, type: 'iframeContentRendered' }, '*') // iframeWin -> mainWin
          })
          Promise.resolve(evTarget).then(addClassNameToInfoHeader)
        }
      }, true)
    }


    // page rendered via CSS rendering
    const race1 = new Promise(resolve => {
      cssTriggeringHook(resolve)
      themeCommon.lyricsAppInit()
    })

    // delay 500ms as a backup
    const race2 = new Promise(resolve => setTimeout(resolve, 500))

    await Promise.race([race1, race2]) // page is rendered or 500ms after written html

    unlistenToMessages() // remove message handler
    removeElements(document.querySelectorAll('iframe')) // remove all embeded iframes inside #lyricsiframe

    // communicationWindow.postMessage({ iAm: custom.scriptName, type: 'lyricsAppInit', html: document.documentElement.innerHTML }, '*')

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
