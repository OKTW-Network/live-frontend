import { ref, computed, onMounted, onUnmounted } from 'vue'

export const useRoute = () => {
  // hash: #cute_panda/cute_panda-1698758357

  // fetch route from hash and remove #
  // stored: 'cute_panda/cute_panda-1698758357'
  const route = ref(window.location.hash.substring(1))

  // split route by /
  // output: ['cute_panda', 'cute_panda-1698758357']
  const splittedRoute = computed(() => {
    return route.value.split('/')
  })

  // get profile name
  // output: 'cute_panda'
  const profileName = computed(() => {
    return splittedRoute.value[0]
  })

  // check if route is profile page by  checking if there is only one element
  const isProfilePage = computed(() => {
    return splittedRoute.value.length === 1 || splittedRoute.value[1].split(':')[0] === ''
  })

  // check if route is a live url
  const isLive = computed(() => {
    return !isProfilePage.value ? splittedRoute.value[1].split(':')[0] === 'live' : false
  })

  // get target filename
  // output:
  // - undefined if profile page
  // - 'cute_panda-1698758357.mp4' if record
  // - 'cute_panda.m3u8' if live
  const targetFilename = computed(() => {
    if (isProfilePage.value) {
      return undefined
    }
    return isLive.value
      ? `${profileName.value}.m3u8`
      : `${splittedRoute.value[1].split(':')[0]}.mp4`
  })

  // get parameters from route with format key=value and split them by :
  // output: ['key1=value1', 'key2=value2']
  const parameters = computed(() => {
    if (isProfilePage.value) {
      return []
    }
    return splittedRoute.value[1].split(':').slice(1)
  })

  // get parameter value by key
  const getParameter = (key) => {
    const parameter = parameters.value.find((parameter) => parameter.startsWith(key))
    if (parameter === undefined) {
      return undefined
    }
    return parameter.split('=')[1]
  }

  // set parameter value by key
  // format: { key1: value1, key2: value2 }
  const setParameter = (values, reset = false) => {
    // if reset is true, remove all current parameters
    const newParameters = reset ? [] : parameters.value.slice(0)

    // add or update parameters
    for (const [key, value] of Object.entries(values)) {
      const parameterIndex = newParameters.findIndex((parameter) => parameter.startsWith(key))
      if (parameterIndex === -1 && value !== undefined) {
        newParameters.push(`${key}=${value}`)
      } else if (value === undefined) {
        newParameters.splice(parameterIndex, 1)
      } else {
        newParameters[parameterIndex] = `${key}=${value}`
      }
    }

    // generate new url
    const newUrl = new URL(window.location.href)
    const targetFilename = isLive.value ? 'live' : splittedRoute.value[1].split(':')[0]
    if (newParameters.length === 0) {
      newUrl.hash = `#${profileName.value}/${targetFilename}`
    } else {
      newUrl.hash = `#${profileName.value}/${targetFilename}:${newParameters.join(':')}`
    }

    return {
      href: newUrl.href,
      hash: newUrl.hash
    }
  }

  // get url without parameters
  const getUrlWithoutParameters = () => {
    const newUrl = new URL(window.location.href)
    const targetFilename = isLive.value ? 'live' : splittedRoute.value[1].split(':')[0]
    newUrl.hash = `#${profileName.value}/${targetFilename}`

    return {
      href: newUrl.href,
      hash: newUrl.hash
    }
  }

  // replace hash on browser
  const replaceHash = (hash) => {
    window.location.replace(hash)
  }

  // merge old url to new url
  const mergeUrl = () => {
    const route = window.location.hash.substring(1).split('/')
    if (route.length === 1) {
      return
    }
    if (
      (route[0] === 'record' && !route[1].startsWith('record')) ||
      (route[0] === 'live' && !route[1].startsWith('live'))
    ) {
      // Old Live
      // #record/cute_panda-1698758357.mp4
      // #live/cute_panda
      const isLive = route[0].startsWith('live')
      const profileName = isLive ? route[1] : route[1].split('-').slice(0, -1).join('-')
      const filename = route[1].replace('.mp4', '').replace('.flv', '')
      replaceHash(`#${profileName}/${isLive ? 'live' : filename}`)
    } else if (route[0] === 'profile' && !route[1].startsWith('profile')) {
      // Beta Old Route
      // #profile/cute_panda/cute_panda-1698758357.mp4
      // #profile/cute_panda/cute_panda.m3u8
      const profileName = route[1]
      if (route.length === 2) {
        replaceHash(`#${profileName}`)
      } else {
        const isLive = route[2] === `${profileName}.m3u8`
        const filename = route[2].replace('.mp4', '').replace('.flv', '')
        replaceHash(`#${profileName}/${isLive ? 'live' : filename}`)
      }
    }
  }

  // update route on hash change
  const updateRoute = () => {
    route.value = window.location.hash.substring(1)
    mergeUrl()
  }

  onMounted(() => {
    window.addEventListener('hashchange', updateRoute)
    mergeUrl()
  })

  onUnmounted(() => {
    window.removeEventListener('hashchange', updateRoute)
  })
  return {
    route,
    profileName,
    isProfilePage,
    isLive,
    targetFilename,
    parameters,
    getParameter,
    setParameter,
    getUrlWithoutParameters,
    replaceHash
  }
}
