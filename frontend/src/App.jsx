import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { useEffect } from "react";
import { supabase } from "./lib/supabase.js";
import { useUserStore } from "./store/useUserStore.js";

import Navbar from "./componenets/Navbar.js";
import Login from "./pages/Login"