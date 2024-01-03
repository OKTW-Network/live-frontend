import { ref, computed, onMounted, onUnmounted } from 'vue'

export const useRoute = () => {
  // fetch route from hash and remove #
  const route = ref(window.location.hash.substring(1))

  // parse route
  const parsedRoute = computed(() => {
    const splittedRaw = route.value.split('/')

    // profile name
    const profileName = splittedRaw[0]

    if (splittedRaw.length === 2) {
      const parametersRaw = splittedRaw[1].split(':')

      if (parametersRaw[0] !== '') {
        // check if route is a live url
        const isLive = splittedRaw[1] === 'live'

        // url filename
        const filename = parametersRaw[0]

        // target filename
        const targetFilename = isLive ? `${profileName}.m3u8` : `${filename}.mp4`

        // parameters from route with format key=value and split them by :
        const parameters = parametersRaw.slice(1)

        return { profileName, isLive, filename, targetFilename, parameters }
      }
    }
    return {
      profileName,
      isLive: false,
      parameters: []
    }
  })

  // get parameter value by key
  const getParameter = (key) => {
    const parameter = parsedRoute.value.parameters.find((parameter) => parameter.startsWith(key))
    if (parameter === undefined) {
      return undefined
    }
    return parameter.split('=')[1]
  }

  // set parameter value by key and return new url
  // format: { key1: value1, key2: value2 }
  const getUrlWithNewParameters = (values, reset = false) => {
    // if reset is true, remove all current parameters
    const newParameters = reset ? [] : parsedRoute.value.parameters.slice(0)

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
    newUrl.hash = `#${parsedRoute.value.profileName}/${parsedRoute.value.filename}`
    if (newParameters.length !== 0) {
      newUrl.hash += `:${newParameters.join(':')}`
    }

    return {
      href: newUrl.href,
      hash: newUrl.hash
    }
  }

  // get url without parameters
  const getUrlWithoutParameters = () => {
    const newUrl = new URL(window.location.href)
    newUrl.hash = `#${parsedRoute.value.profileName}/${parsedRoute.value.filename}`

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

  // Public getters
  const profileName = computed(() => {
    return parsedRoute.value.profileName
  })

  const isProfilePage = computed(() => {
    return parsedRoute.value.targetFilename === undefined
  })

  const isLive = computed(() => {
    return parsedRoute.value.isLive
  })

  const targetFilename = computed(() => {
    return parsedRoute.value.targetFilename
  })

  return {
    route,
    profileName,
    isProfilePage,
    isLive,
    targetFilename,
    getParameter,
    getUrlWithNewParameters,
    getUrlWithoutParameters,
    replaceHash
  }
}
