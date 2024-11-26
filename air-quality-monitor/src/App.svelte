<script>
  import { onMount, onDestroy, tick } from 'svelte';
  import Chart from 'chart.js/auto';
  import 'leaflet/dist/leaflet.css';
  import L from 'leaflet';

  // Fix Leaflet's default icon path issues
  delete L.Icon.Default.prototype._getIconUrl;
  L.Icon.Default.mergeOptions({
    iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
    iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
    shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png'
  });

  // Component state
  let darkMode = false;
  let loading = true;
  let error = null;
  let chartCanvas;
  let chart;
  let currentAQI = 0;
  let location = '';
  let locationInput = '';
  let searchResults = [];
  let isSearching = false;
  let searchError = '';
  let pollutants = {
    PM2_5: 0,
    PM10: 0,
    NO2: 0,
    SO2: 0,
    O3: 0,
    CO: 0
  };
  let forecastData = [];
  let lastUpdateTime = null;
  let map;
  let mapContainer;
  let pollutionLayer;
  let currentMarker;

  // Cache for recent searches
  let searchCache = new Map();

  // Convert OpenWeatherMap AQI (1-5) to US EPA AQI (0-500)
  function convertOpenWeatherMapAQI(owmAQI) {
    const conversion = {
      1: 20,  // Good (0-50)
      2: 60,  // Fair (51-100)
      3: 120, // Moderate (101-150)
      4: 180, // Poor (151-200)
      5: 250  // Very Poor (201-300)
    };
    return conversion[owmAQI] || owmAQI;
  }

  // Watch for canvas changes
  $: if (chartCanvas && forecastData.length > 0) {
    console.log('Canvas or forecast data updated, refreshing chart');
    updateChart(forecastData);
  }

  // Watch for location changes to update the map
  $: if (latitude && longitude && mapContainer) {
    console.log('[Map Debug] Location or container changed:', { latitude, longitude, containerExists: !!mapContainer });
    updateMap(latitude, longitude);
  }

  // Geolocation coordinates (default to New York City)
  let latitude = 40.7128;
  let longitude = -74.0060;

  // Try to get cached position first
  const CACHED_POSITION_KEY = 'user_location';
  const CACHE_EXPIRY_TIME = 30 * 60 * 1000; // 30 minutes

  function getCachedPosition() {
    try {
      const cached = localStorage.getItem(CACHED_POSITION_KEY);
      if (cached) {
        const { lat, lon, timestamp } = JSON.parse(cached);
        if (Date.now() - timestamp < CACHE_EXPIRY_TIME) {
          return { latitude: lat, longitude: lon };
        }
      }
    } catch (err) {
      console.warn('Error reading cached position:', err);
    }
    return null;
  }

  function cachePosition(lat, lon) {
    try {
      localStorage.setItem(
        CACHED_POSITION_KEY,
        JSON.stringify({
          lat,
          lon,
          timestamp: Date.now()
        })
      );
    } catch (err) {
      console.warn('Error caching position:', err);
    }
  }

  async function getUserLocation() {
    return new Promise(async (resolve) => {
      // First, try to get cached position
      const cachedPosition = getCachedPosition();
      if (cachedPosition) {
        console.log('Using cached position');
        latitude = cachedPosition.latitude;
        longitude = cachedPosition.longitude;
        resolve();
        // Still update the cache in the background
        updatePositionInBackground();
        return;
      }

      // If no cached position, try to get current position
      if ("geolocation" in navigator) {
        // Set a timeout for geolocation
        const timeoutId = setTimeout(() => {
          console.log('Geolocation timeout, using default location');
          resolve();
        }, 8000); // 8 second timeout

        try {
          // Request position with high accuracy first
          const position = await new Promise((resolvePos, rejectPos) => {
            navigator.geolocation.getCurrentPosition(
              resolvePos,
              rejectPos,
              { 
                enableHighAccuracy: true,
                timeout: 5000,      // Increased from 2000
                maximumAge: 300000  // Increased from 30000 (5 minutes)
              }
            );
          }).catch(async () => {
            console.log('High accuracy position failed, trying low accuracy');
            // If high accuracy fails, try again with low accuracy
            return await new Promise((resolvePos, rejectPos) => {
              navigator.geolocation.getCurrentPosition(
                resolvePos,
                rejectPos,
                { 
                  enableHighAccuracy: false,
                  timeout: 3000,       // Increased from 1000
                  maximumAge: 600000   // Increased from 60000 (10 minutes)
                }
              );
            });
          });

          clearTimeout(timeoutId);
          
          if (position && position.coords) {
            latitude = position.coords.latitude;
            longitude = position.coords.longitude;
            cachePosition(latitude, longitude);
          }
        } catch (err) {
          console.warn('Geolocation error:', err);
          // Use cached position as fallback if available
          const fallbackPosition = getCachedPosition();
          if (fallbackPosition) {
            latitude = fallbackPosition.latitude;
            longitude = fallbackPosition.longitude;
          }
          // Otherwise, default coordinates will be used
        }
      }
      resolve();
    });
  }

  async function updatePositionInBackground() {
    if ("geolocation" in navigator) {
      try {
        const position = await new Promise((resolve, reject) => {
          // For background updates, we use a watchPosition instead of getCurrentPosition
          const watchId = navigator.geolocation.watchPosition(
            (pos) => {
              navigator.geolocation.clearWatch(watchId);
              resolve(pos);
            },
            (err) => {
              navigator.geolocation.clearWatch(watchId);
              reject(err);
            },
            { 
              enableHighAccuracy: false,
              timeout: 10000,        // Increased timeout for background updates
              maximumAge: 300000     // 5 minutes
            }
          );

          // Clear watch after 12 seconds if no position is received
          setTimeout(() => {
            navigator.geolocation.clearWatch(watchId);
            reject(new Error('Background position update timeout'));
          }, 12000);
        });

        if (position && position.coords) {
          const newLat = position.coords.latitude;
          const newLon = position.coords.longitude;
          
          // Only update if position has changed significantly (more than ~100m)
          const distance = calculateDistance(latitude, longitude, newLat, newLon);
          if (distance > 0.1) {
            console.log('Position changed significantly, updating...');
            latitude = newLat;
            longitude = newLon;
            cachePosition(latitude, longitude);
            // Refresh data with new location
            await Promise.all([fetchLocationName(), fetchAirQuality(), updateMap(latitude, longitude)]);
          } else {
            console.log('Position unchanged or changed insignificantly');
          }
        }
      } catch (err) {
        if (err.code === 3) { // TIMEOUT
          console.log('Background position update timed out - will try again next cycle');
        } else {
          console.warn('Background position update failed:', err);
        }
      }
    }
  }

  // Calculate distance between two points in kilometers
  function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Earth's radius in kilometers
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = 
      Math.sin(dLat/2) * Math.sin(dLat/2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
      Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  }

  async function fetchLocationName() {
    try {
      const response = await fetch(
        `/api/data/2.5/weather?lat=${latitude}&lon=${longitude}&appid=${import.meta.env.VITE_OPENWEATHER_API_KEY}`
      );
      if (!response.ok) {
        throw new Error('Failed to fetch location data');
      }
      const data = await response.json();
      
      // Get state/region from additional API call
      const geoResponse = await fetch(
        `/api/geo/1.0/reverse?lat=${latitude}&lon=${longitude}&limit=1&appid=${import.meta.env.VITE_OPENWEATHER_API_KEY}`
      );
      if (!geoResponse.ok) {
        throw new Error('Failed to fetch detailed location data');
      }
      const geoData = await geoResponse.json();
      const state = geoData[0]?.state || '';
      
      // Format location as "City, State, Country"
      const parts = [
        data.name, // City
        state,     // State
        data.sys.country // Country
      ].filter(Boolean); // Remove empty parts
      
      location = parts.join(', ');
    } catch (err) {
      console.error('Error fetching location name:', err);
      location = 'Location unavailable';
    }
  }

  async function updateChart(data) {
    if (!chartCanvas) {
      console.warn('Chart canvas not available');
      return;
    }

    console.log('Updating chart with data:', data); // Debug log

    const ctx = chartCanvas.getContext('2d');
    
    if (chart) {
      chart.destroy();
    }

    const labels = data.map(item => {
      const date = new Date(item.dt * 1000);
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    });

    const aqi_data = data.map(item => convertOpenWeatherMapAQI(item.main.aqi));
    
    console.log('Chart labels:', labels); // Debug log
    console.log('Chart data:', aqi_data); // Debug log

    try {
      // Calculate dynamic scale based on data
      const maxAQI = Math.max(...aqi_data);
      const minAQI = Math.min(...aqi_data);
      const range = maxAQI - minAQI;
      
      // Set the max to be 20% above the highest value, but at least 50
      const suggestedMax = Math.max(maxAQI * 1.2, Math.min(maxAQI + 20, 50));
      // Set step size based on the range of values
      const stepSize = range <= 20 ? 5 : range <= 50 ? 10 : range <= 100 ? 20 : 50;

      // Format current date
      const currentDate = new Date().toLocaleDateString(undefined, {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });

      chart = new Chart(ctx, {
        type: 'line',
        data: {
          labels: labels,
          datasets: [
            {
              label: 'Air Quality Index',
              data: aqi_data,
              borderColor: getAQIColor(Math.max(...aqi_data)),
              backgroundColor: 'transparent',
              tension: 0.4,
              borderWidth: 2,
              pointRadius: 3,
              pointHoverRadius: 5,
              pointBackgroundColor: darkMode ? '#e5e7eb' : '#374151',
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            title: {
              display: true,
              text: [`24-hour Forecast for ${location}`, currentDate],
              color: darkMode ? '#e5e7eb' : '#374151',
              font: {
                size: 14,
                weight: 'normal'
              },
              padding: {
                bottom: 15
              }
            },
            legend: {
              display: false,
            },
            tooltip: {
              mode: 'index',
              intersect: false,
              backgroundColor: darkMode ? '#374151' : 'white',
              titleColor: darkMode ? '#e5e7eb' : '#1f2937',
              bodyColor: darkMode ? '#e5e7eb' : '#1f2937',
              borderColor: darkMode ? '#4b5563' : '#e5e7eb',
              borderWidth: 1,
              padding: 12,
              displayColors: false,
              callbacks: {
                label: function(context) {
                  return `AQI: ${context.raw}`;
                },
              },
            },
          },
          scales: {
            y: {
              beginAtZero: true,
              suggestedMax: suggestedMax,
              grid: {
                color: darkMode ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)',
              },
              ticks: {
                color: darkMode ? '#e5e7eb' : '#374151',
                stepSize: stepSize,
                callback: function(value) {
                  return value + ' AQI';
                },
              },
              title: {
                display: true,
                text: 'Air Quality Index (AQI)',
                color: darkMode ? '#e5e7eb' : '#374151',
                font: {
                  size: 12,
                  weight: 'normal'
                }
              }
            },
            x: {
              grid: {
                display: false,
              },
              ticks: {
                color: darkMode ? '#e5e7eb' : '#374151',
                maxRotation: 45,
                minRotation: 45,
              },
              title: {
                display: true,
                text: 'Time',
                color: darkMode ? '#e5e7eb' : '#374151',
                font: {
                  size: 12,
                  weight: 'normal'
                }
              }
            },
          },
        },
      });
      console.log('Chart created successfully');
    } catch (err) {
      console.error('Error creating chart:', err);
    }
  }

  async function fetchAirQuality() {
    try {
      // Fetch current air quality and forecast in parallel
      const [currentResponse, forecastResponse] = await Promise.all([
        fetch(
          `/api/data/2.5/air_pollution?lat=${latitude}&lon=${longitude}&appid=${import.meta.env.VITE_OPENWEATHER_API_KEY}`
        ),
        fetch(
          `/api/data/2.5/air_pollution/forecast?lat=${latitude}&lon=${longitude}&appid=${import.meta.env.VITE_OPENWEATHER_API_KEY}`
        )
      ]);
      
      if (!currentResponse.ok) {
        throw new Error('Failed to fetch air quality data');
      }

      if (!forecastResponse.ok) {
        throw new Error('Failed to fetch forecast data');
      }

      const [currentData, forecastDataResponse] = await Promise.all([
        currentResponse.json(),
        forecastResponse.json()
      ]);
      
      if (!currentData.list || !currentData.list[0]) {
        throw new Error('Invalid air quality data format');
      }

      // Process current data
      const current = currentData.list[0];
      currentAQI = convertOpenWeatherMapAQI(current.main.aqi); // Use the same conversion function
      pollutants = {
        PM2_5: current.components.pm2_5,
        PM10: current.components.pm10,
        NO2: current.components.no2,
        SO2: current.components.so2,
        O3: current.components.o3,
        CO: current.components.co
      };

      // Process forecast data for the chart
      if (forecastDataResponse.list && forecastDataResponse.list.length > 0) {
        forecastData = forecastDataResponse.list.slice(0, 24);
        console.log('Forecast data:', forecastData); // Debug log
        if (chartCanvas) {
          updateChart(forecastData);
        }
      }

      lastUpdateTime = new Date(currentData.list[0].dt * 1000);

    } catch (err) {
      console.error('Error fetching air quality data:', err);
      error = 'Failed to fetch air quality data. Please try again later.';
    }
  }

  async function updateMap(lat, lon) {
    console.log('[Map Debug] updateMap called with:', { lat, lon });
    if (!mapContainer) {
      console.log('[Map Debug] Map container not ready yet');
      return;
    }

    try {
      if (!map) {
        console.log('[Map Debug] Creating new map instance');
        // Initialize map if it doesn't exist
        map = L.map(mapContainer, {
          zoomControl: true,
          scrollWheelZoom: false // Disable scroll zoom by default
        }).setView([lat, lon], 10);

        console.log('[Map Debug] Map instance created:', !!map);

        // Add dark/light mode aware tiles
        const tileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: 'OpenStreetMap contributors',
          className: darkMode ? 'map-tiles-dark' : 'map-tiles-light'
        }).addTo(map);

        console.log('[Map Debug] Tile layer added:', !!tileLayer);

        // Add zoom control to top-right
        map.zoomControl.setPosition('topright');

        // Enable scroll zoom on map focus
        map.on('focus', () => { 
          console.log('[Map Debug] Map focused - enabling scroll zoom');
          map.scrollWheelZoom.enable(); 
        });
        // Disable scroll zoom when mouse leaves map
        map.on('blur', () => { 
          console.log('[Map Debug] Map blurred - disabling scroll zoom');
          map.scrollWheelZoom.disable(); 
        });

        // Add debug event listeners
        map.on('load', () => console.log('[Map Debug] Map load event fired'));
        map.on('error', (e) => console.error('[Map Debug] Map error:', e));
      } else {
        console.log('[Map Debug] Updating existing map view');
        map.setView([lat, lon], 10);
      }

      // Update or create marker with custom popup
      if (currentMarker) {
        console.log('[Map Debug] Updating existing marker position');
        currentMarker.setLatLng([lat, lon]);
      } else {
        console.log('[Map Debug] Creating new marker');
        currentMarker = L.marker([lat, lon])
          .bindPopup(`<div class="text-center font-semibold">${location}</div>`)
          .addTo(map);
      }

      // Fetch air pollution data for the map
      console.log('[Map Debug] Fetching air pollution data');
      const response = await fetch(
        `https://api.openweathermap.org/data/2.5/air_pollution?lat=${lat}&lon=${lon}&appid=${import.meta.env.VITE_OPENWEATHER_API_KEY}`
      );
      const data = await response.json();
      console.log('[Map Debug] Air pollution data received:', data);

      // Remove existing pollution layer if it exists
      if (pollutionLayer) {
        console.log('[Map Debug] Removing existing pollution layer');
        map.removeLayer(pollutionLayer);
      }

      // Convert OpenWeatherMap AQI (1-5) to US EPA AQI (0-500)
      const owmAQI = data.list[0].main.aqi;
      const convertedAQI = convertOpenWeatherMapAQI(owmAQI);
      const color = getAQIColor(convertedAQI);
      console.log('[Map Debug] Creating pollution layer with AQI:', owmAQI, 'converted to:', convertedAQI);
      pollutionLayer = L.circle([lat, lon], {
        color: color,
        fillColor: color,
        fillOpacity: 0.2,
        weight: 2,
        radius: 10000 // 10km radius
      }).addTo(map);

      // Add popup with AQI information
      pollutionLayer.bindPopup(`
        <div class="text-center p-2">
          <div class="font-semibold mb-1">Air Quality Index: ${convertedAQI}</div>
          <div class="text-sm">${getAQIDescription(convertedAQI)}</div>
          <div class="text-xs mt-1 text-gray-600">10km radius area</div>
        </div>
      `);

      // Add a legend to the map
      if (!map.legend) {
        const legend = L.control({ position: 'bottomright' });
        legend.onAdd = function() {
          const div = L.DomUtil.create('div', 'info legend');
          const isDarkMode = document.documentElement.classList.contains('dark');
          
          // Apply styles based on dark mode
          div.style.backgroundColor = isDarkMode ? '#1f2937' : 'white';
          div.style.color = isDarkMode ? '#e5e7eb' : '#1f2937';
          div.style.padding = '8px';
          div.style.borderRadius = '4px';
          div.style.border = isDarkMode ? '1px solid #374151' : '1px solid #e5e7eb';
          
          const grades = [0, 50, 100, 150, 200, 300];
          const labels = ['Good', 'Moderate', 'Unhealthy for Sensitive Groups', 'Unhealthy', 'Very Unhealthy', 'Hazardous'];
          
          div.innerHTML = '<div class="text-sm font-semibold mb-2" style="color: inherit;">Air Quality Index</div>';
          
          for (let i = 0; i < grades.length; i++) {
            const color = getAQIColor(grades[i] + 1);
            div.innerHTML += `
              <div class="flex items-center mb-1">
                <div style="background-color: ${color}; width: 12px; height: 12px; margin-right: 8px;"></div>
                <span class="text-xs" style="color: inherit;">${labels[i]}</span>
              </div>
            `;
          }
          
          // Update legend colors when dark mode changes
          const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
              if (mutation.attributeName === 'class') {
                const isDark = document.documentElement.classList.contains('dark');
                div.style.backgroundColor = isDark ? '#1f2937' : 'white';
                div.style.color = isDark ? '#e5e7eb' : '#1f2937';
                div.style.border = isDark ? '1px solid #374151' : '1px solid #e5e7eb';
              }
            });
          });
          
          observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['class']
          });
          
          return div;
        };
        legend.addTo(map);
        map.legend = legend;
      }

      // Force a map refresh
      console.log('[Map Debug] Forcing map refresh');
      map.invalidateSize();

    } catch (error) {
      console.error('[Map Debug] Error updating map:', error);
    }
  }

  function getAQIColor(aqi) {
    // Convert OpenWeatherMap AQI (1-5) to our scale (0-300+)
    if (typeof aqi === 'number' && aqi >= 1 && aqi <= 5) {
      switch(aqi) {
        case 1: return '#22c55e'; // Good - green-500
        case 2: return '#eab308'; // Fair - yellow-500
        case 3: return '#f97316'; // Moderate - orange-500
        case 4: return '#ef4444'; // Poor - red-500
        case 5: return '#8F3F97'; // Very Poor - purple
        default: return '#6b7280'; // gray-500
      }
    }
    
    // Regular AQI scale (0-300+)
    if (aqi <= 50) return '#22c55e';
    if (aqi <= 100) return '#eab308';
    if (aqi <= 150) return '#f97316';
    if (aqi <= 200) return '#ef4444';
    if (aqi <= 300) return '#8F3F97';
    return '#6b7280';
  }

  function getAQIDescription(aqi) {
    // Convert OpenWeatherMap AQI (1-5) to text
    if (typeof aqi === 'number' && aqi >= 1 && aqi <= 5) {
      switch(aqi) {
        case 1: return 'Good';
        case 2: return 'Fair';
        case 3: return 'Moderate';
        case 4: return 'Poor';
        case 5: return 'Very Poor';
        default: return 'Unknown';
      }
    }
    
    // Regular AQI scale (0-300+)
    if (aqi <= 50) return 'Good';
    if (aqi <= 100) return 'Moderate';
    if (aqi <= 150) return 'Unhealthy for Sensitive Groups';
    if (aqi <= 200) return 'Unhealthy';
    if (aqi <= 300) return 'Very Unhealthy';
    return 'Hazardous';
  }

  function getAQIStatus(aqi) {
    return getAQIDescription(aqi);
  }

  function getTextColorForAQI(aqi) {
    // Use dark text for light backgrounds (Good and Moderate)
    if (aqi <= 100) return '#1f2937'; // gray-800
    // Use white text for darker backgrounds
    return 'white';
  }

  function getDominantPollutant(pollutants) {
    if (!pollutants) return null;
    // Get WHO guidelines for comparison
    const guidelines = {
      'PM2_5': 15,
      'PM10': 45,
      'NO2': 25,
      'SO2': 40,
      'O3': 100,
      'CO': 4000 // in μg/m³
    };
    
    let maxRatio = 0;
    let dominant = null;
    
    Object.entries(pollutants).forEach(([key, value]) => {
      const ratio = value / guidelines[key];
      if (ratio > maxRatio) {
        maxRatio = ratio;
        dominant = key;
      }
    });
    
    return dominant;
  }

  function getPollutantDescription(key) {
    if (key === 'PM2_5') return 'Fine particles (≤2.5µm)';
    if (key === 'PM10') return 'Coarse particulate matter (≤10µm)';
    if (key === 'NO2') return 'Nitrogen dioxide';
    if (key === 'SO2') return 'Sulfur dioxide';
    if (key === 'O3') return 'Ozone';
    if (key === 'CO') return 'Carbon monoxide';
  }

  function getHealthRecommendations(aqi) {
    if (aqi <= 50) {
      return {
        activity: "It's a great time for outdoor activities",
        sensitive: "No special precautions needed",
        ventilation: "Ideal for natural ventilation"
      };
    } else if (aqi <= 100) {
      return {
        activity: "Unusually sensitive people should consider reducing prolonged outdoor activities",
        sensitive: "Children and elderly should monitor their outdoor exposure",
        ventilation: "Good time for ventilation, but monitor local conditions"
      };
    } else if (aqi <= 150) {
      return {
        activity: "Reduce prolonged or heavy outdoor exertion",
        sensitive: "Children, elderly, and those with respiratory issues should limit outdoor exposure",
        ventilation: "Consider using air purifiers when ventilating"
      };
    } else if (aqi <= 200) {
      return {
        activity: "Avoid prolonged or heavy outdoor exertion",
        sensitive: "Children, elderly, and sensitive groups should avoid outdoor activities",
        ventilation: "Keep windows closed, use air purification"
      };
    } else if (aqi <= 300) {
      return {
        activity: "Avoid all outdoor activities",
        sensitive: "Stay indoors and keep activity levels low",
        ventilation: "Keep windows closed, run air purifiers if available"
      };
    } else {
      return {
        activity: "Stay indoors and avoid physical activity",
        sensitive: "Everyone should avoid all outdoor exposure",
        ventilation: "Seal windows and doors, use air purification"
      };
    }
  }

  function formatLastUpdateTime(timestamp) {
    if (!timestamp) return '';
    const now = new Date();
    const updateTime = new Date(timestamp);
    const diffMinutes = Math.floor((now - updateTime) / 1000 / 60);
    
    if (diffMinutes < 1) return 'Just now';
    if (diffMinutes === 1) return '1 minute ago';
    if (diffMinutes < 60) return `${diffMinutes} minutes ago`;
    
    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours === 1) return '1 hour ago';
    if (diffHours < 24) return `${diffHours} hours ago`;
    
    return updateTime.toLocaleDateString();
  }

  async function searchLocation(query) {
    if (!query.trim()) return;
    
    // Only search if we have at least 3 characters, unless it's a zip code
    if (query.length < 3 && !/^\d+$/.test(query)) {
      searchResults = [];
      return;
    }
    
    isSearching = true;
    searchError = '';
    try {
      let endpoint;
      // Check if input is a US zip code (5 digits)
      if (/^\d{5}$/.test(query)) {
        endpoint = `https://api.openweathermap.org/geo/1.0/zip?zip=${query},US&appid=${import.meta.env.VITE_OPENWEATHER_API_KEY}`;
      } else {
        // For city searches, append a wildcard to help with partial matches
        endpoint = `https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(query)}&limit=10&appid=${import.meta.env.VITE_OPENWEATHER_API_KEY}`;
      }
      
      const response = await fetch(endpoint);
      const data = await response.json();
      
      if (response.status === 404 || (Array.isArray(data) && data.length === 0)) {
        // Try a more lenient search if no results found and it's not a zip code
        if (!/^\d{5}$/.test(query) && query.length >= 3) {
          const lenientQuery = query.slice(0, -1); // Remove last character for more lenient search
          const lenientResponse = await fetch(
            `https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(lenientQuery)}&limit=10&appid=${import.meta.env.VITE_OPENWEATHER_API_KEY}`
          );
          const lenientData = await lenientResponse.json();
          
          if (lenientData.length > 0) {
            // Filter lenient results to only include relevant matches
            const filteredResults = lenientData.filter(item => 
              item.name.toLowerCase().includes(query.toLowerCase())
            );
            if (filteredResults.length > 0) {
              searchResults = filteredResults.map(item => ({
                name: item.name,
                state: item.state,
                country: item.country,
                lat: item.lat,
                lon: item.lon
              }));
              return;
            }
          }
        }
        searchError = 'No locations found. Try a different search term.';
        searchResults = [];
      } else if (!Array.isArray(data)) {
        // Single result from zip code search
        searchResults = [{
          name: data.name,
          state: '',
          country: data.country,
          lat: data.lat,
          lon: data.lon
        }];
      } else {
        // Results from city search
        searchResults = data.map(item => ({
          name: item.name,
          state: item.state,
          country: item.country,
          lat: item.lat,
          lon: item.lon
        }));
      }
    } catch (error) {
      console.error('Error searching location:', error);
      searchError = 'Error searching for location. Please try again.';
      searchResults = [];
    } finally {
      isSearching = false;
    }
  }

  let searchTimeout;
  function handleSearchInput() {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      searchLocation(locationInput);
    }, 300);
  }

  async function selectLocation(result) {
    location = result.state ? 
      `${result.name}, ${result.state}, ${result.country}` : 
      `${result.name}, ${result.country}`;
    
    // Update coordinates and fetch new data
    latitude = result.lat;
    longitude = result.lon;
    
    // Clear search
    locationInput = '';
    searchResults = [];
    
    // Fetch new data for selected location
    await Promise.all([
      fetchLocationName(),
      fetchAirQuality(),
      updateMap(latitude, longitude)
    ]);
  }

  // Initialize dark mode from system preference
  function initializeTheme() {
    darkMode = window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (darkMode) {
      document.documentElement.classList.add('dark');
    }
  }

  // Watch for system theme changes
  function watchSystemTheme() {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    mediaQuery.addEventListener('change', (e) => {
      darkMode = e.matches;
      if (darkMode) {
        document.documentElement.classList.add('dark');
      } else {
        document.documentElement.classList.remove('dark');
      }
      if (chart) {
        updateChart(forecastData);
      }
    });
  }

  function toggleDarkMode() {
    darkMode = !darkMode;
    if (darkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    
    if (chart) {
      updateChart(forecastData);
    }
  }

  async function initializeApp() {
    try {
      loading = true;
      error = null;

      // Initialize theme based on system preference
      initializeTheme();
      watchSystemTheme();

      // Get user location
      await getUserLocation();

      // Wait for next tick to ensure DOM is updated
      await tick();

      // Fetch location name and air quality data in parallel
      await Promise.all([
        fetchLocationName(),
        fetchAirQuality()
      ]);

      // Initialize map after other data is loaded
      if (mapContainer) {
        await updateMap(latitude, longitude);
      }

      // Set up auto-refresh every 5 minutes
      setInterval(async () => {
        await Promise.all([
          updatePositionInBackground(),
          fetchAirQuality()
        ]);
      }, 5 * 60 * 1000);

    } catch (err) {
      console.error('Error initializing app:', err);
      error = 'Something went wrong. Please try again later.';
    } finally {
      loading = false;
    }
  }

  onMount(async () => {
    console.log('[Map Debug] Component mounted');
    await initializeApp();

    // Wait for the map container to be available
    await tick();
    console.log('[Map Debug] After tick - Map container exists:', !!mapContainer);
    if (mapContainer) {
      console.log('[Map Debug] Map container dimensions:', {
        width: mapContainer.offsetWidth,
        height: mapContainer.offsetHeight,
        clientWidth: mapContainer.clientWidth,
        clientHeight: mapContainer.clientHeight
      });
      updateMap(latitude, longitude);
    }
  });

  onDestroy(() => {
    console.log('[Map Debug] Component being destroyed');
    if (map) {
      console.log('[Map Debug] Removing map instance');
      map.remove();
      map = null;
    }
    if (chart) {
      chart.destroy();
      chart = null;
    }
  });
</script>

<main class="min-h-screen transition-colors duration-200 bg-white dark:bg-dark-primary">
  <div class="container mx-auto px-4 py-8 max-w-4xl">
    <!-- Theme Toggle Button -->
    <div class="flex justify-end mb-4">
      <button
        on:click={toggleDarkMode}
        class="p-2 rounded-full hover:bg-gray-200 dark:hover:bg-dark-secondary transition-colors duration-200"
        aria-label="Toggle dark mode"
      >
        {#if darkMode}
          <svg class="w-6 h-6 text-yellow-500" fill="currentColor" viewBox="0 0 20 20">
            <path d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v3a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z" />
          </svg>
        {:else}
          <svg class="w-6 h-6 text-gray-700" fill="currentColor" viewBox="0 0 20 20">
            <path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z" />
          </svg>
        {/if}
      </button>
    </div>

    {#if error}
      <div class="text-center p-4 bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-100 rounded-lg mb-4">
        {error}
      </div>
    {/if}

    <h1 class="text-4xl font-bold text-center mb-8 text-gray-900 dark:text-dark-text">Air Quality Monitor</h1>
    
    {#if loading}
      <div class="flex justify-center items-center h-64">
        <div class="animate-spin rounded-full h-16 w-16 border-b-2 border-blue-500"></div>
      </div>
    {:else}
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4 p-4">
        <!-- Current Air Quality Card -->
        <div class="bg-white dark:bg-dark-secondary rounded-lg shadow p-4 h-fit transition-colors duration-200">
          <h2 class="text-xl font-semibold mb-4 text-gray-900 dark:text-dark-text">Current Air Quality</h2>
          <div class="flex flex-col items-center mb-4">
            <div class="relative mb-4">
              <div class="text-6xl font-bold text-gray-900 dark:text-dark-text pr-6" style="color: {getAQIColor(currentAQI)}">{currentAQI}</div>
              <div class="absolute -right-2 top-2 text-sm font-medium px-2 py-1 rounded-full" 
                   style="background-color: {getAQIColor(currentAQI)}; color: {getTextColorForAQI(currentAQI)}; opacity: 0.95">
                AQI
              </div>
            </div>
            <div class="text-lg font-medium px-4 py-1 rounded-full" 
                 style="background-color: {getAQIColor(currentAQI)}; color: {getTextColorForAQI(currentAQI)}; opacity: 0.95">
              {getAQIStatus(currentAQI)}
            </div>
          </div>
          <div class="text-gray-600 dark:text-dark-muted text-center mt-3">
            <div class="relative">
              <div class="flex items-center justify-center mb-2">
                <svg class="w-4 h-4 mr-1" fill="currentColor" viewBox="0 0 20 20">
                  <path fill-rule="evenodd" d="M5.05 4.05a7 7 0 119.9 9.9L10 18.9l-4.95-4.95a7 7 0 010-9.9zM10 11a2 2 0 100-4 2 2 0 000 4z" />
                </svg>
                <span>{location}</span>
              </div>
              <div class="flex justify-center">
                <div class="relative w-64">
                  <input
                    type="text"
                    placeholder="Search city or zip code..."
                    class="w-full px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600 
                           bg-white dark:bg-dark-secondary text-gray-900 dark:text-dark-text
                           focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400 focus:border-transparent"
                    bind:value={locationInput}
                    on:input={handleSearchInput}
                  />
                  {#if isSearching}
                    <div class="absolute right-2 top-2">
                      <div class="animate-spin h-4 w-4 border-2 border-blue-500 rounded-full border-t-transparent"></div>
                    </div>
                  {/if}
                  
                  {#if searchResults.length > 0}
                    <div class="absolute z-10 w-full mt-1 bg-white dark:bg-dark-secondary rounded-lg shadow-lg 
                              border border-gray-200 dark:border-gray-700 max-h-60 overflow-auto">
                      {#each searchResults as result}
                        <button
                          class="w-full px-4 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-700 
                                 text-gray-900 dark:text-dark-text text-sm"
                          on:click={() => selectLocation(result)}
                        >
                          {result.state ? 
                            `${result.name}, ${result.state}, ${result.country}` : 
                            `${result.name}, ${result.country}`}
                        </button>
                      {/each}
                    </div>
                  {/if}
                  
                  {#if searchError}
                    <div class="absolute w-full mt-1 px-3 py-2 text-sm text-red-600 dark:text-red-400 
                              bg-white dark:bg-dark-secondary rounded-lg shadow-lg 
                              border border-red-200 dark:border-red-800">
                      {searchError}
                    </div>
                  {/if}
                </div>
              </div>
            </div>
          </div>

          <div class="border-t border-gray-200 dark:border-gray-700 mt-4 pt-4">
            <div class="text-sm font-medium mb-3 text-gray-900 dark:text-dark-text">Quick Stats:</div>
            <div class="grid grid-cols-2 gap-4">
              <!-- Dominant Pollutant -->
              <div>
                <div class="text-xs text-gray-500 dark:text-gray-400 text-center mb-2">Dominant Pollutant</div>
                <div class="flex items-center justify-center">
                  <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 text-yellow-500 mr-1.5" viewBox="0 0 20 20" fill="currentColor">
                    <path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 011 1v3a1 1 0 11-2 0V6a1 1 0 011-1z" clip-rule="evenodd" />
                  </svg>
                  <span class="font-medium text-gray-900 dark:text-dark-text">
                    {#if pollutants}
                      {#if getDominantPollutant(pollutants) === 'PM2_5'}
                        PM2.5
                      {:else if getDominantPollutant(pollutants) === 'CO'}
                        CO
                      {:else}
                        {getDominantPollutant(pollutants)}
                      {/if}
                    {:else}
                      --
                    {/if}
                  </span>
                </div>
              </div>

              <!-- Last Updated -->
              <div>
                <div class="text-xs text-gray-500 dark:text-gray-400 text-center mb-2">Last Updated</div>
                <div class="flex items-center justify-center">
                  <svg class="w-4 h-4 mr-1" fill="currentColor" viewBox="0 0 20 20">
                    <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clip-rule="evenodd" />
                  </svg>
                  <span class="font-medium text-gray-900 dark:text-dark-text">
                    {#if lastUpdateTime}
                      {new Date(lastUpdateTime).toLocaleTimeString()}
                    {:else}
                      N/A
                    {/if}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div class="border-t border-gray-200 dark:border-gray-700 mt-4 pt-4">
            <h3 class="font-medium mb-2 text-gray-900 dark:text-dark-text">Health Recommendations:</h3>
            {#if currentAQI}
              {@const recommendations = getHealthRecommendations(currentAQI)}
              <div class="space-y-3">
                <div class="flex items-start gap-3">
                  <div class="flex-shrink-0 w-5 h-5 mt-0.5">
                    <svg xmlns="http://www.w3.org/2000/svg" class="text-blue-500" viewBox="0 0 20 20" fill="currentColor">
                      <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" />
                    </svg>
                  </div>
                  <div class="flex-1 text-sm text-gray-600 dark:text-dark-muted">{recommendations.activity}</div>
                </div>
                <div class="flex items-start gap-3">
                  <div class="flex-shrink-0 w-5 h-5 mt-0.5">
                    <svg xmlns="http://www.w3.org/2000/svg" class="text-blue-500" viewBox="0 0 20 20" fill="currentColor">
                      <path fill-rule="evenodd" d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z" />
                    </svg>
                  </div>
                  <div class="flex-1 text-sm text-gray-600 dark:text-dark-muted">{recommendations.sensitive}</div>
                </div>
                <div class="flex items-start gap-3">
                  <div class="flex-shrink-0 w-5 h-5 mt-0.5">
                    <svg xmlns="http://www.w3.org/2000/svg" class="text-blue-500" viewBox="0 0 20 20" fill="currentColor">
                    <path fill-rule="evenodd" d="M3.43 2.524A41.29 41.29 0 0110 2c2.236 0 4.43.18 6.57.524 1.437.231 2.43 1.49 2.43 2.902v5.148c0 1.413-.993 2.67-2.43 2.902a41.102 41.102 0 01-3.55.414c-.28.02-.521.18-.643.413l-1.712 3.293a.75.75 0 01-1.33 0l-1.713-3.293a.783.783 0 00-.642-.413 41.108 41.108 0 01-3.55-.414C1.993 13.245 1 11.986 1 10.574V5.426c0-1.413.993-2.67 2.43-2.902z" />
                  </svg>
                  </div>
                  <div class="flex-1 text-sm text-gray-600 dark:text-dark-muted">{recommendations.ventilation}</div>
                </div>
              </div>
            {/if}
          </div>

          <div class="border-t border-gray-200 dark:border-gray-700 mt-4 pt-4">
            <div class="text-sm font-medium mb-3 text-gray-900 dark:text-dark-text">AQI Scale:</div>
            <div class="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              <div class="flex items-center">
                <div class="w-3 h-3 rounded bg-green-500 mr-2"></div>
                <span class="text-gray-700 dark:text-dark-muted">0-50: Good</span>
              </div>
              <div class="flex items-center">
                <div class="w-3 h-3 rounded bg-yellow-500 mr-2"></div>
                <span class="text-gray-700 dark:text-dark-muted">51-100: Moderate</span>
              </div>
              <div class="flex items-center">
                <div class="w-3 h-3 rounded bg-orange-500 mr-2"></div>
                <span class="text-gray-700 dark:text-dark-muted">101-150: Poor</span>
              </div>
              <div class="flex items-center">
                <div class="w-3 h-3 rounded bg-red-500 mr-2"></div>
                <span class="text-gray-700 dark:text-dark-muted">151-200: Unhealthy</span>
              </div>
              <div class="flex items-center">
                <div class="w-3 h-3 rounded bg-purple-500 mr-2"></div>
                <span class="text-gray-700 dark:text-dark-muted">201-300: Very Unhealthy</span>
              </div>
              <div class="flex items-center">
                <div class="w-3 h-3 rounded bg-red-900 mr-2"></div>
                <span class="text-gray-700 dark:text-dark-muted">300+: Hazardous</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Pollutants Card -->
        <div class="bg-white dark:bg-dark-secondary rounded-lg shadow p-4 transition-colors duration-200">
          <h2 class="text-xl font-semibold mb-4 text-gray-900 dark:text-dark-text">Pollutants</h2>
          <div class="space-y-4">
            {#each Object.entries(pollutants) as [key, value]}
              <div class="space-y-2">
                <div class="flex flex-col">
                  <div class="flex justify-between items-center">
                    <span class="font-medium text-gray-900 dark:text-dark-text">
                      {#if key === 'PM2_5'}
                        PM2.5
                      {:else if key === 'CO'}
                        CO
                      {:else}
                        {key}
                      {/if}
                    </span>
                    <span class="font-medium text-gray-900 dark:text-dark-text">
                      {#if key === 'CO'}
                        {(value / 1000).toFixed(2)} mg/m³
                      {:else}
                        {value.toFixed(2)} μg/m³
                      {/if}
                    </span>
                  </div>
                  <div class="text-sm text-gray-600 dark:text-dark-muted mt-1">{getPollutantDescription(key)}</div>
                  <div class="relative h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden mt-2">
                    {#if key === 'PM2_5'}
                      <div class="absolute h-full bg-blue-500" style="width: {Math.min((value / 15) * 100, 100)}%"></div>
                    {:else if key === 'PM10'}
                      <div class="absolute h-full bg-blue-500" style="width: {Math.min((value / 45) * 100, 100)}%"></div>
                    {:else if key === 'NO2'}
                      <div class="absolute h-full bg-blue-500" style="width: {Math.min((value / 25) * 100, 100)}%"></div>
                    {:else if key === 'SO2'}
                      <div class="absolute h-full bg-blue-500" style="width: {Math.min((value / 40) * 100, 100)}%"></div>
                    {:else if key === 'O3'}
                      <div class="absolute h-full bg-blue-500" style="width: {Math.min((value / 100) * 100, 100)}%"></div>
                    {:else if key === 'CO'}
                      <div class="absolute h-full bg-blue-500" style="width: {Math.min(((value / 1000) / 4) * 100, 100)}%"></div>
                    {/if}
                  </div>
                </div>
              </div>
            {/each}
          </div>

          <div class="border-t border-gray-200 dark:border-gray-700 mt-4 pt-4">
            <h3 class="font-medium mb-2 text-gray-900 dark:text-dark-text">WHO Guidelines (24-hour mean)</h3>
            <ul class="text-sm space-y-1 text-gray-600 dark:text-dark-muted">
              <li>PM2.5: 15 μg/m³</li>
              <li>PM10: 45 μg/m³</li>
              <li>NO2: 25 μg/m³</li>
              <li>SO2: 40 μg/m³</li>
              <li>O3: 100 μg/m³</li>
              <li>CO: 4 mg/m³</li>
            </ul>
          </div>
        </div>
      </div>

      <!-- Map Section -->
      <div class="mt-4 bg-white dark:bg-dark-secondary rounded-lg shadow overflow-hidden">
        <div class="p-4">
          <h2 class="text-xl font-semibold mb-2 text-gray-900 dark:text-dark-text">Air Quality Map</h2>
          <div style="height: 400px !important; min-height: 400px !important;" class="w-full relative rounded-lg overflow-hidden" bind:this={mapContainer}></div>
        </div>
      </div>

      <!-- Forecast Chart -->
      <div class="mt-8 bg-white dark:bg-dark-secondary rounded-lg shadow-lg p-6 transition-colors duration-200">
        <h2 class="text-2xl font-semibold mb-4 text-gray-900 dark:text-dark-text">24-Hour Forecast</h2>
        <div class="relative h-64 w-full">
          <canvas bind:this={chartCanvas} class="absolute inset-0"></canvas>
        </div>
      </div>

      <!-- Recommendations -->
      <div class="mt-8 bg-white dark:bg-dark-secondary rounded-lg shadow-lg p-6 transition-colors duration-200">
        <h2 class="text-2xl font-semibold mb-4 text-gray-900 dark:text-dark-text">Recommendations</h2>
        <ul class="list-disc pl-6 space-y-2 text-gray-700 dark:text-dark-muted">
          {#if currentAQI <= 50}
            <li>Air quality is good! Perfect for outdoor activities.</li>
          {:else if currentAQI <= 100}
            <li>Sensitive individuals should consider reducing prolonged outdoor activities.</li>
            <li>Keep windows closed during peak pollution hours.</li>
          {:else}
            <li>Avoid prolonged outdoor activities.</li>
            <li>Use air purifiers indoors.</li>
            <li>Wear a mask when outdoors if necessary.</li>
          {/if}
        </ul>
      </div>
    {/if}
  </div>
</main>

<style>
  :global(body) {
    margin: 0;
    padding: 0;
  }

  :global(.map-tiles-dark) {
    filter: brightness(0.6) invert(1) contrast(3) hue-rotate(200deg) saturate(0.3) brightness(0.7);
  }

  :global(.leaflet-popup-content-wrapper) {
    border-radius: 0.5rem;
  }

  :global(.leaflet-popup-content) {
    margin: 0.5rem 0.75rem;
  }

  :global(.dark .leaflet-popup-content-wrapper) {
    background-color: #1f2937;
    color: #e5e7eb;
  }

  :global(.dark .leaflet-popup-tip) {
    background-color: #1f2937;
  }

  /* Add explicit height to map container */
  :global(.leaflet-container) {
    height: 100% !important;
    min-height: 100% !important;
    width: 100%;
    background: #f8fafc;
  }

  :global(.dark .leaflet-container) {
    background: #1f2937;
  }

  /* Map container styles */
  :global(.leaflet-container) {
    height: 100% !important;
    min-height: 100% !important;
    width: 100%;
    background: #f8fafc;
  }

  :global(.dark .leaflet-container) {
    background: #1f2937;
  }

  :global(.leaflet-control-container .leaflet-top.leaflet-right) {
    margin-top: 10px;
    margin-right: 10px;
  }
</style>
